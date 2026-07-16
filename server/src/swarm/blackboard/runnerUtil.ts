import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

import type { Agent } from "../../services/AgentManager.js";
import type { AgentState, SwarmPhase, TranscriptEntry, TranscriptEntrySummary } from "../../types.js";
import { buildCrashSnapshot } from "./crashSnapshot.js";
import {
  buildWireSnapshot,
  v2QueueCountsToWireCounts,
  v2QueueTodoToWireTodo,
} from "./boardWireCompat.js";
import { resolveSafe } from "./resolveSafe.js";
import { writeFileAtomic } from "./writeFileAtomic.js";
import { parsePlannerBrief } from "../../../../shared/src/plannerBriefParse.js";
import { summarizeAgentResponse } from "./transcriptSummary.js";
import {
  finalizeAgentOutput,
  formatFinalizeAnomalyLine,
} from "@ollama-swarm/shared/finalizeAgentOutput";
import { takePendingToolTrace, type ToolTraceEntry } from "../toolCallTranscript.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueue } from "./TodoQueue.js";
import type { FindingsLog } from "./FindingsLog.js";
import type { LifecycleState } from "./lifecycleState.js";
import type { PlanningSubphase } from "@ollama-swarm/shared/planningSubphase";

export type PendingPrompt = { text: string; label?: string };

export interface RunnerUtilContext {
  active?: RunConfig;
  phase: SwarmPhase;
  planningSubphase?: PlanningSubphase;
  round: number;
  runStartedAt?: number;
  transcript: TranscriptEntry[];
  pendingPromptByAgent?: Map<string, PendingPrompt>;
  pendingToolTraceByAgent?: Map<string, ToolTraceEntry[]>;
  todoQueue: TodoQueue;
  findings: FindingsLog;
  activeAborts: Set<AbortController>;
  lifecycleState: LifecycleState;
  terminationReason?: string;
  getAmendments?: () => Array<{ ts: number; text: string }>;
  scheduleStateWrite(): void;
  appendSystem(text: string, summary?: TranscriptEntrySummary): void;
  emit(e: { type: string; [key: string]: unknown }): void;
}

export async function writeCrashSnapshot(
  ctx: RunnerUtilContext,
  err: unknown,
): Promise<void> {
  const clone = ctx.active?.localPath;
  if (!clone) {
    ctx.appendSystem("Could not write crash snapshot: no clone path set.");
    return;
  }
  const snapshot = buildCrashSnapshot({
    error: err,
    phase: ctx.phase,
    runStartedAt: ctx.runStartedAt,
    crashedAt: Date.now(),
    config: ctx.active,
    board: boardSnapshot(ctx),
    transcript: ctx.transcript,
  });
  const outPath = path.join(clone, "board-final.json");
  try {
    await writeFileAtomic(outPath, JSON.stringify(snapshot, null, 2));
    ctx.appendSystem(`Wrote crash snapshot to ${outPath}`);
  } catch (writeErr) {
    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    ctx.appendSystem(`Failed to write crash snapshot (${msg})`);
  }
}

export function boardCounts(ctx: RunnerUtilContext) {
  return v2QueueCountsToWireCounts(ctx.todoQueue.counts());
}

export function boardListTodos(ctx: RunnerUtilContext) {
  return ctx.todoQueue.list().map(v2QueueTodoToWireTodo);
}

export function boardSnapshot(ctx: RunnerUtilContext) {
  return buildWireSnapshot(ctx.todoQueue.list(), ctx.findings.list());
}

export function boardGetTodo(ctx: RunnerUtilContext, id: string) {
  const t = ctx.todoQueue.get(id);
  return t ? v2QueueTodoToWireTodo(t) : undefined;
}

export async function readExpectedFiles(
  clonePath: string | undefined,
  files: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  // Parallel reads — saves ~500ms-2s per worker turn on multi-file todos.
  await Promise.all(
    files.map(async (f) => {
      try {
        const abs = await resolveSafePath(clonePath, f);
        out[f] = await fs.readFile(abs, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          out[f] = null;
        } else {
          throw err;
        }
      }
    }),
  );
  return out;
}

export async function resolveSafePath(
  clonePath: string | undefined,
  relPath: string,
): Promise<string> {
  if (!clonePath) throw new Error("no active clone path");
  return resolveSafe(clonePath, relPath);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function directiveWithAmendments(ctx: RunnerUtilContext): string | undefined {
  const base = ctx.active?.userDirective?.trim() ?? "";
  const amendments = ctx.getAmendments?.() ?? [];
  if (amendments.length === 0) {
    return base.length > 0 ? base : undefined;
  }
  const nudges = amendments
    .map((a, i) => {
      const stamp = new Date(a.ts).toISOString();
      return `[user nudge #${i + 1} @ ${stamp}] ${a.text}`;
    })
    .join("\n");
  const header =
    "MID-RUN USER NUDGES (treat as additions to the directive — incorporate into the next contract):";
  return base.length > 0
    ? `${base}\n\n${header}\n${nudges}`
    : `${header}\n${nudges}`;
}

export type AgentAssistKind = "auditor-salvage" | "auditor-diagnostic";

export type PlannerBriefKind = "goal_analysis" | "research_brief";

export interface AppendAgentOptions {
  assistKind?: AgentAssistKind;
  /** Tags planner pre-pass output for PlannerBriefBubble rendering. */
  briefKind?: PlannerBriefKind;
}

export function appendAgent(
  ctx: RunnerUtilContext,
  agent: Agent,
  text: string,
  options?: AppendAgentOptions,
): void {
  // Canonical post-stream policy (strip / collapse loops / hard-cap).
  const finalized = finalizeAgentOutput(text, { role: "general" });
  const { finalText, thoughts, toolCalls, anomalies, stats } = finalized;
  const anomalyLine = formatFinalizeAnomalyLine(agent.id, anomalies, stats);
  if (anomalyLine) {
    ctx.appendSystem(anomalyLine);
  }
  let summary = summarizeAgentResponse(finalText);
  if (options?.briefKind) {
    const parsed = parsePlannerBrief(finalText);
    summary = {
      kind: "planner_brief",
      variant: options.briefKind,
      chars: finalText.length,
      sections: parsed.sections.length || (parsed.title ? 1 : 0),
      ...(parsed.title ? { title: parsed.title } : {}),
    };
  }

  const pending = ctx.pendingPromptByAgent?.get(agent.id);
  if (pending) ctx.pendingPromptByAgent?.delete(agent.id);
  const toolTrace = takePendingToolTrace(ctx.pendingToolTraceByAgent, agent.id);

  const entry: TranscriptEntry = {
    id: randomUUID(),
    role: "agent",
    agentId: agent.id,
    agentIndex: agent.index,
    text: finalText || "(empty response)",
    ts: Date.now(),
    summary,
    ...(thoughts.length > 0 ? { thoughts } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(options?.assistKind ? { assistKind: options.assistKind } : {}),
    ...(pending?.text
      ? {
          promptText: pending.text,
          ...(pending.label ? { promptLabel: pending.label } : {}),
        }
      : {}),
    ...(toolTrace ? { toolTrace } : {}),
  };
  ctx.transcript.push(entry);
  ctx.emit({ type: "transcript_append", entry });
}

export function setPhase(
  ctx: RunnerUtilContext,
  phase: SwarmPhase,
): void {
  ctx.phase = phase;
  if (phase !== "seeding" && phase !== "planning") {
    ctx.planningSubphase = undefined;
  }
  ctx.emit({
    type: "swarm_state",
    phase,
    round: ctx.round,
    ...(ctx.planningSubphase ? { planningSubphase: ctx.planningSubphase } : {}),
  });
  ctx.scheduleStateWrite();
}

export function setPlanningSubphase(
  ctx: RunnerUtilContext,
  subphase: PlanningSubphase | undefined,
): void {
  ctx.planningSubphase = subphase;
  ctx.emit({
    type: "swarm_state",
    phase: ctx.phase,
    round: ctx.round,
    ...(subphase ? { planningSubphase: subphase } : {}),
  });
  ctx.scheduleStateWrite();
}

export function emitAgentState(
  manager: { recordAgentState(s: AgentState): void },
  s: AgentState,
): void {
  manager.recordAgentState(s);
}

export function extractText(res: unknown): string | undefined {
  const any = res as {
    data?: {
      parts?: Array<{ type?: string; text?: string }>;
      info?: { parts?: Array<{ type?: string; text?: string }> };
      text?: string;
    };
  };
  const parts = any?.data?.parts ?? any?.data?.info?.parts;
  if (Array.isArray(parts)) {
    const texts = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string);
    if (texts.length) return texts.join("\n");
  }
  return any?.data?.text;
}