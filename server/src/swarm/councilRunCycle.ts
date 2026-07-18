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
import { reconcileCriteriaFromSkips } from "./councilSkipReconcile.js";
import type { PostTodoInput } from "./blackboard/TodoQueue.js";
import type { SwarmControlCenter } from "./control/SwarmControlCenter.js";
import { runCouncilResearchStandup } from "./councilResearchStandup.js";
import { checkCouncilResourceCaps } from "./councilResourceGates.js";
import {
  cycleExecutionSettled,
  isPermanentSkipReason,
  permanentSkipReason,
  summarizeUnresolved,
} from "./councilCycleSettlement.js";

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
  /** Run wall-clock start (ms) for cap checks. */
  getStartedAt?: () => number | undefined;
  /** Token baseline at run start for tokenBudget checks. */
  getTokenBaseline?: () => number | undefined;
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
  drainTodos: (
    cfg: RunConfig,
    cycle: number,
  ) => Promise<{ done: number; failed: number; skipped: number }>;
  finalizeCycleProgress: (cycle: number) => void;
  /**
   * Record cycle execution counts; return "stop" when thrash circuit fires.
   * Optional for unit hosts that only exercise discussion.
   */
  noteCycleExecutionHealth?: (counts: {
    done: number;
    failed: number;
    skipped: number;
  }) => "ok" | "stop";
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
  // Fail-closed: autonomous rounds=0 can otherwise ignore caps until user Stop.
  const capHit = checkCouncilResourceCaps({
    wallClockCapMs: cfg.wallClockCapMs,
    startedAt: host.getStartedAt?.(),
    tokenBudget: cfg.tokenBudget,
    tokenBaseline: host.getTokenBaseline?.(),
  });
  if (capHit.stop) {
    host.setEarlyStopDetail(capHit.detail);
    host.appendSystem(
      `[cap] ${capHit.detail} — ending council cycle ${cycle} (fail-closed resource gate).`,
    );
    notifyGuardTrip({
      kind: capHit.kind === "tokens" ? "token-budget" : "wall-clock",
      detail: capHit.detail,
      runId: host.getRunId?.() ?? cfg.runId,
      appendSystem: (t, s) => host.appendSystem(t, s),
      getBrainService: host.getBrainService,
    });
    return "stop";
  }

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
  let drainCounts = { done: 0, failed: 0, skipped: 0 };
  if (!host.getStopping()) {
    drainCounts = await host.drainTodos(cfg, cycle);
  }

  if (host.closingRequested()) {
    // Soft drain / hard stop: permanently skip residual soft-failed work so
    // the run does not leave the board half-settled without a reason.
    abandonUnresolvedCouncilTodos(host, cycle, "run stopping");
    host.finalizeCycleProgress(cycle);
    return "stop";
  }

  // Execution thrash circuit (runs 4de10651 / 36632e9e class).
  if (host.noteCycleExecutionHealth?.(drainCounts) === "stop") {
    abandonUnresolvedCouncilTodos(host, cycle, "execution thrash circuit");
    host.finalizeCycleProgress(cycle);
    return "stop";
  }

  if (!cycleExecutionSettled(host.state.todoQueue)) {
    const leftover = summarizeUnresolved(host.state.todoQueue);
    host.appendSystem(
      `[execution] Cycle queue not fully settled (${leftover}) — permanent-skipping residual fails before audit.`,
    );
    abandonUnresolvedCouncilTodos(host, cycle, "cycle settlement incomplete");
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

/** Convert residual failed/soft-skipped todos to permanent skips so audit sees settled queue. */
function abandonUnresolvedCouncilTodos(
  host: CouncilRunCycleHost,
  _cycle: number,
  reason: string,
): void {
  const q = host.state.todoQueue;
  let n = 0;
  for (const t of q.list()) {
    if (t.status === "failed") {
      try {
        q.skip(t.id, permanentSkipReason("attempts-exhausted", reason));
        n++;
      } catch {
        /* ignore */
      }
      continue;
    }
    if (t.status === "skipped" && !isPermanentSkipReason(t.reason)) {
      t.reason = permanentSkipReason("attempts-exhausted", t.reason ?? reason);
      n++;
    }
  }
  if (n > 0) {
    host.appendSystem(
      `[execution] Abandoned ${n} residual todo(s) as permanent-skip (${reason}).`,
    );
  }
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
  // NOTE: Deliverable + wrap-up intentionally NOT here.
  // Runs 36632e9e / similar burned 1–2h writing deliverable and wrap-up
  // (tool-loop thrash) *before* drainTodos executed the enqueued work.
  // End-of-run closeout in CouncilRunner.loop owns deliverable/wrap-up.
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
  // Empty-execution sets host.stopping + earlyStopDetail; caller returns "stop"
  // via closingRequested() after this function (no fire-and-forget stop()).
}
