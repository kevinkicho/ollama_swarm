// Council cycle body (discussion / standup / drain / audit) — extracted from CouncilRunner.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { SwarmEvent, SwarmPhase, TranscriptEntry } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { RepoService } from "../services/RepoService.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import type { CouncilProgressLedger } from "./councilProgressLedger.js";
import { harvestStandupFindingsFromEntries } from "./councilProgressLedger.js";
import { burstSpacingForModels, staggerStart } from "./staggerStart.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { notifyGuardTrip } from "./guardNotify.js";
import { runSynthesisPass } from "./councilSynthesis.js";
import { extractActionableTodos } from "./councilDecisions.js";
import { postCouncilTodoBatch } from "./councilTodoPlan.js";
import { persistCouncilPendingTodos } from "./councilExecutionResume.js";
import { writeCouncilDeliverable } from "./councilDeliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { reconcileCriteriaFromSkips } from "./councilSkipReconcile.js";
import type { PostTodoInput } from "./blackboard/TodoQueue.js";
import type { SwarmControlCenter } from "./control/SwarmControlCenter.js";
import { runCouncilResearchStandup } from "./councilResearchStandup.js";

export interface CouncilRunCycleHost {
  state: CouncilAdapterState;
  transcript: TranscriptEntry[];
  progressLedger: CouncilProgressLedger;
  repoFiles: string[];
  codeContextExcerpts: ReadonlyArray<{ path: string; excerpt: string }>;
  executionFailures: string[];
  round: number;
  earlyStopDetail: string | undefined;
  setEarlyStopDetail: (d: string | undefined) => void;
  swarmControl: SwarmControlCenter;
  manager: AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
  logDiag?: (entry: unknown) => void;
  stats: any;
  setCycleTranscriptStart: (n: number) => void;
  getCycleTranscriptStart: () => number;
  setExecutionFailures: (f: string[]) => void;
  getExecutionFailures: () => string[];
  syncProgressContext: () => void;
  prependCouncilControlHints: () => void;
  appendSystem: (text: string, summary?: unknown) => void;
  setPhase: (p: SwarmPhase) => void;
  closingRequested: () => boolean;
  getStopping: () => boolean;
  runTurn: (
    agent: Agent,
    round: number,
    totalRounds: number,
    snapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ) => Promise<void>;
  runStandupTurn: (
    agent: Agent,
    snapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ) => Promise<void>;
  runDiscussionAgent: (
    agent: Agent,
    prompt: string,
    opts: unknown,
  ) => Promise<unknown>;
  postCouncilTodo: (input: PostTodoInput) => string;
  synthesizeStandup: (cfg: RunConfig, cycle: number) => Promise<void>;
  cycleTranscriptSlice: () => TranscriptEntry[];
  drainTodos: (cfg: RunConfig, cycle: number) => Promise<void>;
  finalizeCycleProgress: (cycle: number) => void;
  runAudit: (cfg: RunConfig, cycle: number) => Promise<"done" | "retry" | "stop">;
  getRunId?: () => string | undefined;
  getBrainService?: () =>
    | { injectSuggestion?: (runId: string, s: { title: string; text: string; category?: string }) => void }
    | null
    | undefined;
}

export async function runCouncilCycle(
  host: CouncilRunCycleHost,
  cfg: RunConfig,
  cycle: number,
  _isAutonomous: boolean,
): Promise<"done" | "retry" | "stop"> {
  host.setCycleTranscriptStart(host.transcript.length);
  host.progressLedger.lastCycle = cycle;
  host.syncProgressContext();
  host.prependCouncilControlHints();

  const hasPendingTodos = host.state.todoQueue.counts().pending > 0;

  if (hasPendingTodos) {
    const pending = host.state.todoQueue.counts().pending;
    host.appendSystem(
      `═══ Council cycle ${cycle} — draining ${pending} pending todo(s) ═══`,
      { kind: "council_cycle", cycle, executionOnly: true, pendingTodos: pending },
    );
  } else {
    host.appendSystem(`═══ Council cycle ${cycle} ═══`, {
      kind: "council_cycle",
      cycle,
      executionOnly: false,
    });

    if (cycle === 1) {
      await runCycle1Discussion(host, cfg, cycle);
    } else {
      await runCycleStandup(host, cfg, cycle);
    }

    // Optional collective research standup (opt-in). Default is independent
    // research via per-todo literature pass only (cfg.councilSharedResearch).
    if (!host.closingRequested() && cfg.councilSharedResearch === true) {
      try {
        const notes = await runCouncilResearchStandup({
          manager: host.manager,
          cfg,
          cycle,
          appendSystem: (t, s) => host.appendSystem(t, s),
          closingRequested: () => host.closingRequested(),
        });
        if (notes) {
          const prev = host.state.progressContext ?? "";
          host.state.progressContext =
            `[Research standup — cycle ${cycle}]\n${notes}\n[End research standup]\n\n` + prev;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        host.appendSystem(`[research] Standup skipped (${msg}).`);
      }
    }
  }

  host.setExecutionFailures([]);
  if (!host.getStopping()) {
    await host.drainTodos(cfg, cycle);
  }

  if (host.closingRequested()) {
    host.finalizeCycleProgress(cycle);
    return "stop";
  }

  if (host.state.contract) {
    const skippedTodos = host.state.todoQueue
      .list()
      .filter((t) => t.status === "skipped");
    const { criteria: reconciled, promotedIds } = reconcileCriteriaFromSkips(
      host.state.contract.criteria,
      skippedTodos,
      host.repoFiles,
    );
    if (promotedIds.length > 0) {
      host.state.contract = { ...host.state.contract, criteria: reconciled };
      host.appendSystem(
        `[execution] Promoted ${promotedIds.length} criterion(s) to met from worker skips: ${promotedIds.join(", ")}.`,
      );
    }
  }

  if (!host.closingRequested() && host.state.contract) {
    const auditResult = await host.runAudit(cfg, cycle);
    host.finalizeCycleProgress(cycle);
    if (auditResult === "stop") return "stop";
    if (auditResult === "retry") return "retry";
    return "done";
  }

  host.finalizeCycleProgress(cycle);
  return "done";
}

async function runCycle1Discussion(
  host: CouncilRunCycleHost,
  cfg: RunConfig,
  cycle: number,
): Promise<void> {
  host.setPhase("discussing");
  host.appendSystem(`Analysis — 3 round(s)`, {
    kind: "council_stage",
    cycle,
    stage: "discussion",
    detail: "3 rounds",
  });

  // Empty/junk discussion turns only (revisers often restate peers with shared vocabulary).
  const deadLoopGuard = new OutputEmptyDeadLoopGuard({
    roleLabel: "drafters",
    unit: "round",
  });
  for (let r = 1; r <= 3; r++) {
    if (host.closingRequested()) break;
    const transcriptLenBefore = host.transcript.length;
    const snapshot: readonly TranscriptEntry[] = [...host.transcript];
    const agents = host.manager.list();
    await staggerStart(
      agents,
      (agent) => host.runTurn(agent, r, 3, snapshot, cfg.userDirective),
      burstSpacingForModels(agents),
    );
    if (!host.getStopping()) {
      const newEntries = host.transcript
        .slice(transcriptLenBefore)
        .filter((e) => e.role === "agent");
      const dlHit = deadLoopGuard.recordIteration(newEntries);
      if (dlHit.tripped) {
        host.setEarlyStopDetail(dlHit.earlyStopDetail);
        host.appendSystem(
          `All drafters produced empty/junk output for ${dlHit.consecutive} consecutive rounds — ending council discussion early.`,
        );
        notifyGuardTrip({
          kind: "output-empty",
          detail: dlHit.earlyStopDetail ?? "drafters-silenced",
          runId: host.getRunId?.() ?? cfg.runId,
          appendSystem: (t, s) => host.appendSystem(t, s),
          getBrainService: host.getBrainService,
        });
        break;
      }
    }
  }

  if (!host.closingRequested()) {
    await runSynthesisPass(
      cfg,
      host.transcript,
      host.closingRequested(),
      host.stats,
      host.runDiscussionAgent.bind(host) as any,
      {
        manager: host.manager as any,
        emit: host.emit as any,
        getSwarmControl: () => host.swarmControl,
        getCoachAgent: () => host.manager.list().find((a) => a.index === 1),
        appendSystem: ((msg: string) => {
          if (msg.startsWith("Synthesizing council consensus")) {
            host.appendSystem(msg, {
              kind: "council_stage",
              cycle,
              stage: "synthesis",
              detail: `agent-1`,
            });
          } else {
            host.appendSystem(msg);
          }
        }) as any,
        logDiag: (host.logDiag ?? (() => {})) as any,
      },
      host.state.committedFiles,
      host.state.currentTier,
      host.repoFiles,
      host.codeContextExcerpts,
    );

    const lead = host.manager.list().find((a) => a.index === 1);
    if (lead) {
      const synthesisTodos = await extractActionableTodos(
        lead,
        cfg,
        host.transcript,
        host.repos,
        (msg) => host.appendSystem(msg),
        host.manager as any,
        host.state.contract,
        host.state.progressContext,
      );
      const enqueued = postCouncilTodoBatch(
        (input) => host.postCouncilTodo(input),
        synthesisTodos.map((t) => ({
          description: t.description,
          expectedFiles: t.expectedFiles,
          createdBy: "council-synthesis",
        })),
        (msg) => host.appendSystem(msg),
      );
      if (enqueued > 0) {
        host.appendSystem(`[synthesis] Enqueued ${enqueued} actionable todo(s).`, {
          kind: "council_stage",
          cycle,
          stage: "execution",
          detail: `${enqueued} synthesis todo(s)`,
        });
        const clonePath = cfg.localPath ?? "";
        if (cfg.runId && clonePath) {
          persistCouncilPendingTodos(clonePath, cfg.runId, host.state.todoQueue.list());
        }
      }
    }
  }

  if (!host.getStopping() && cfg.runId) {
    await writeCouncilDeliverable(
      cfg,
      host.transcript,
      null,
      host.round,
      host.earlyStopDetail,
      undefined,
      {
        manager: host.manager as any,
        repos: host.repos as any,
        emit: host.emit as any,
        appendSystem: ((text: string) => host.appendSystem(text)) as any,
      },
    );
    const wrapLead = host.manager.list().find((a) => a.index === 1);
    if (wrapLead) {
      await maybeRunWrapUpApply({
        cfg,
        presetName: "council",
        agent: wrapLead,
        manager: host.manager,
        repos: host.repos,
        emit: host.emit,
        appendSystem: (text) => host.appendSystem(text),
        relevantFiles: [],
      });
    }
  }
}

async function runCycleStandup(
  host: CouncilRunCycleHost,
  cfg: RunConfig,
  cycle: number,
): Promise<void> {
  host.setPhase("discussing");
  const unmetCount =
    host.state.contract?.criteria.filter((c) => c.status !== "met").length ?? 0;
  host.appendSystem(
    `[Standup] Planning next batch — ${host.state.contract?.criteria.length ?? 0} criteria, ${unmetCount} unmet.`,
    {
      kind: "council_stage",
      cycle,
      stage: "standup",
      detail: `${unmetCount} unmet criteria`,
    },
  );

  const failures = host.getExecutionFailures();
  if (failures.length > 0) {
    host.appendSystem(
      `[Standup] Previous failures:\n${failures.map((f) => `  ${f}`).join("\n")}`,
    );
  }

  const snapshot: readonly TranscriptEntry[] = [...host.transcript];
  const standupAgents = host.manager.list();
  await staggerStart(
    standupAgents,
    (agent) => host.runStandupTurn(agent, snapshot, cfg.userDirective),
    burstSpacingForModels(standupAgents),
  );

  harvestStandupFindingsFromEntries(
    host.progressLedger,
    cycle,
    host.cycleTranscriptSlice(),
  );

  await host.synthesizeStandup(cfg, cycle);
}
