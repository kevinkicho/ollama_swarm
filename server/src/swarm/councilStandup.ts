/**
 * Council cycle-2+ standup: per-agent turns + lead synthesis → todos.
 * Extracted from CouncilRunner for modularity.
 */

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { TranscriptEntry } from "../types.js";
import type { ExitContract } from "./blackboard/types.js";
import type { PostTodoInput } from "./blackboard/TodoQueue.js";
import {
  buildStandupPrompt,
  buildStandupSynthesisPrompt,
} from "./councilPromptHelpers.js";
import {
  appendLedgerObservation,
  type CouncilProgressLedger,
} from "./councilProgressLedger.js";
import { standupFallbackTodosFromEntries } from "./councilStandupFallback.js";
import { postCouncilTodoBatch } from "./councilTodoPlan.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractProviderText, parseJsonArrayFromResponse } from "./councilUtils.js";
import { resolveCouncilToolProfile } from "./toolProfiles.js";

export interface CouncilStandupHost {
  manager: AgentManager;
  state: {
    contract?: ExitContract | null;
    progressContext?: string;
    committedFiles: string[];
  };
  progressLedger: CouncilProgressLedger;
  active?: RunConfig | null;
  repoFiles: string[];
  appendSystem: (msg: string, summary?: TranscriptEntry["summary"]) => void;
  postCouncilTodo: (input: PostTodoInput) => string;
  cycleTranscriptSlice: () => TranscriptEntry[];
  runDiscussionAgent: (
    agent: Agent,
    prompt: string,
    opts: Record<string, unknown>,
  ) => Promise<unknown>;
  stats: unknown;
}

export async function synthesizeStandup(
  host: CouncilStandupHost,
  cfg: RunConfig,
  cycle: number,
): Promise<void> {
  const agents = host.manager.list();
  const lead = agents.find((a) => a.index === 1);
  if (!lead) return;

  const standupEntries = host.cycleTranscriptSlice().filter(
    (e) =>
      e.role === "agent"
      && e.summary?.kind === "council_draft"
      && (e.summary as { phase?: string }).phase === "standup",
  );
  const proposals = standupEntries
    .map((e) => `[Agent ${e.agentIndex}]:\n${e.text}`)
    .join("\n\n---\n\n");

  if (!proposals) return;

  const prompt = buildStandupSynthesisPrompt(proposals, host.state.progressContext);

  const controller = new AbortController();
  let standupEnqueued = 0;
  host.manager.markStatus(lead.id, "thinking", {
    activityKind: "council",
    activityLabel: "standup synthesis",
  });
  try {
    const raw = await promptWithFailoverAuto(
      lead,
      prompt,
      {
        manager: host.manager,
        agentName: resolveCouncilToolProfile(cfg),
        webToolsConfig: cfg,
        signal: controller.signal,
        activity: { kind: "council", label: "standup synthesis" },
      },
      cfg.providerFailover,
    );
    const text = extractProviderText(raw);
    if (text) {
      const todos = parseJsonArrayFromResponse(text, (item: any) => ({
        description: String(item.description ?? ""),
        expectedFiles: Array.isArray(item.expectedFiles)
          ? item.expectedFiles.map(String)
          : [],
      }));
      const standupDrafts = todos
        .filter((todo) => todo.description)
        .map((todo) => ({
          description: todo.description,
          expectedFiles: todo.expectedFiles,
          createdBy: "council" as const,
        }));
      standupEnqueued = postCouncilTodoBatch(
        (input) => host.postCouncilTodo(input),
        standupDrafts,
        (msg) => host.appendSystem(msg),
      );
    }
  } catch (err) {
    host.appendSystem(
      `[council] Standup synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    host.manager.markStatus(lead.id, "ready");
  }

  if (standupEnqueued === 0) {
    const fallback = standupFallbackTodosFromEntries(standupEntries);
    if (fallback.length > 0) {
      standupEnqueued = postCouncilTodoBatch(
        (input) => host.postCouncilTodo(input),
        fallback,
        (msg) => host.appendSystem(msg),
      );
      appendLedgerObservation(host.progressLedger, {
        kind: "synthesis",
        text: `Agent-1 merge produced no todos; enqueued ${standupEnqueued} from standup agent drafts.`,
        cycle,
      });
      host.appendSystem(
        `[Standup] Merge empty — enqueued ${standupEnqueued} todo(s) from agent standup drafts.`,
      );
    } else {
      appendLedgerObservation(host.progressLedger, {
        kind: "synthesis",
        text: "Standup merge produced no todos and no parseable standup drafts.",
        cycle,
      });
      host.appendSystem(`[Standup] Synthesized 0 proposals into unified plan.`);
    }
  } else {
    appendLedgerObservation(host.progressLedger, {
      kind: "synthesis",
      text: `Synthesized ${standupEnqueued} proposal(s) into unified plan.`,
      cycle,
    });
    host.appendSystem(
      `[Standup] Synthesized ${standupEnqueued} proposals into unified plan.`,
    );
  }
}

export async function runStandupTurn(
  host: CouncilStandupHost,
  agent: Agent,
  snapshot: readonly TranscriptEntry[],
  userDirective?: string,
): Promise<void> {
  const prompt = buildStandupPrompt(
    agent.index,
    {
      missionStatement: host.state.contract?.missionStatement ?? "",
      criteria: host.state.contract?.criteria ?? [],
    },
    host.state.committedFiles,
    userDirective,
    host.active?.localPath,
    host.repoFiles,
    agent.model,
    host.state.progressContext,
  );
  await host.runDiscussionAgent(agent, prompt, {
    runnerName: "council",
    agentName: resolveCouncilToolProfile(host.active ?? undefined),
    activity: { kind: "council", label: "standup" },
    stats: host.stats,
    enrichSummary: {
      kind: "council_draft",
      round: 1,
      phase: "standup" as "draft",
    },
  });
}
