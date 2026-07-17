// Stigmergy territory / report-out / explorer turn — extracted from StigmergyRunner.

import { randomUUID } from "node:crypto";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type {
  AgentState,
  SwarmEvent,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { finalizeAgentOutput } from "@ollama-swarm/shared/finalizeAgentOutput";
import { getAgentAddendum } from "@ollama-swarm/shared/topology";
import {
  type AnnotationState,
  type ParsedAnnotation,
  rankingScore,
  stripAnnotationEnvelope,
  parseAnnotation,
  buildExplorerPrompt,
  buildTerritoryPlanPrompt,
  parseTerritoryPlan,
  describeSdkError,
} from "./stigmergyPromptHelpers.js";
import { pheromoneHeatmap } from "./pheromoneHeatmap.js";
import {
  isSaturated,
  pickNextFileWithDecay,
  DEFAULT_MAX_REVISITS,
} from "./pheromoneDecay.js";

export interface StigmergyTurnsHost {
  manager: AgentManager;
  emit: (e: SwarmEvent) => void;
  logDiag?: (entry: unknown) => void;
  transcript: TranscriptEntry[];
  annotations: Map<string, AnnotationState>;
  territoryAssignments: Map<number, string>;
  round: number;
  active: RunConfig | undefined;
  stats: {
    countTurn: (id: string) => void;
    recordTokens: (id: string, p: number, r: number) => void;
    onTiming: (id: string, success: boolean, elapsedMs: number) => void;
    onRetry: (id: string) => void;
    recordJunkPostRetry: (id: string, junk: boolean) => number;
  };
  getStopping: () => boolean;
  appendSystem: (text: string, summary?: unknown) => void;
  emitAgentState: (s: AgentState) => void;
  runAgent: (
    agent: Agent,
    prompt: string,
    opts?: {
      transformEntry?: (text: string) => { text: string; summary?: TranscriptEntrySummary };
    },
  ) => Promise<string>;
  applyAnnotation: (ann: ParsedAnnotation) => void;
}

export async function runTerritoryPlanPass(
host: StigmergyTurnsHost,
cfg: RunConfig,
  agents: readonly Agent[],
  candidatePaths: readonly string[],
): Promise<void> {
  const lead = agents.find((a) => a.index === 1);
  if (!lead) return;
  if (host.getStopping()) return;
  const prompt = buildTerritoryPlanPrompt({
    directive: cfg.userDirective ?? "",
    candidatePaths,
    explorerCount: agents.length,
  });
  host.appendSystem(`[improvement #2] Lead agent (${lead.id}) drafting per-explorer territory assignments…`);
  const controller = new AbortController();
  let raw = "";
  try {
    // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
    const res = (await promptWithFailoverAuto(lead, prompt, {
      signal: controller.signal,
      manager: host.manager,
      agentName: "swarm-read",
      promptAddendum: getAgentAddendum(host.active?.topology, lead.index),
      describeError: describeSdkError,
    })) as { data: { parts: Array<{ type: "text"; text: string }> } };
    raw = (res?.data?.parts?.find((p) => p.type === "text")?.text ?? "").trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    host.appendSystem(`[improvement #2] Lead's territory-plan prompt failed (${msg}); explorers will wander.`);
    return;
  }
  const parsed = parseTerritoryPlan(raw);
  if (!parsed) {
    host.appendSystem(`[improvement #2] Could not parse lead's territory plan; explorers will wander. Raw: ${raw.slice(0, 200)}`);
    return;
  }
  let assignedCount = 0;
  for (const [agentIndex, territory] of parsed.entries()) {
    if (territory && territory.trim().length > 0) {
      host.territoryAssignments.set(agentIndex, territory.trim());
      assignedCount += 1;
    }
  }
  host.appendSystem(`[improvement #2] Territory plan accepted: ${assignedCount}/${agents.length} explorers assigned a starting territory.`);
}


export async function runReportOutPass(
host: StigmergyTurnsHost,
): Promise<void> {
  const agents = host.manager.list();
  const lead = agents.find((a) => a.index === 1);
  if (!lead) return;
  host.manager.markStatus(lead.id, "thinking");
  host.emitAgentState({
    id: lead.id,
    index: lead.index,
    port: lead.port,
    sessionId: lead.sessionId,
    status: "thinking",
    thinkingSince: Date.now(),
  });
  host.stats.countTurn(lead.id);
  host.appendSystem(`Synthesizing stigmergy findings (agent-${lead.index})…`);

  // Server-side ranking — annotations sorted by rankingScore (visits ×
  // avgInterest × confidence × decay). Pre-2026-05-02 the formula
  // was just visits × avgInterest, which ignored confidence + treated
  // stale annotations as fresh. Top 10 surfaces the highest-signal
  // files; cap prevents prompt bloat on big repos.
  const ranked = [...host.annotations.entries()]
    .map(([file, a]) => ({ file, ...a, score: rankingScore(a, host.round) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  const tableText = ranked
    .map((r, i) => `${i + 1}. ${r.file} — visits=${r.visits}, interest=${r.avgInterest.toFixed(1)}, confidence=${r.avgConfidence.toFixed(1)}, score=${r.score.toFixed(1)}, note="${r.latestNote}"`)
    .join("\n");
  const prompt = [
    "You are Agent 1, the stigmergy synthesis lead. The swarm just finished exploring a repo with self-organizing file picks driven by a shared annotation table.",
    "Your job NOW is to produce a human-readable REPORT-OUT summarizing what the swarm found.",
    "",
    "STRUCTURE your response as:",
    "1. **Top findings** — 3-5 bullets naming the most interesting files and WHY (cite the agents' notes).",
    "2. **Coverage** — what was explored well, what was missed (any obvious gaps in the pheromone table?).",
    "3. **Recommended next action** — ONE concrete next step a developer should take based on what the swarm surfaced.",
    "",
    "Keep it under ~400 words. Be specific. Reference file paths. Don't just restate the table — interpret it.",
    "",
    "=== TOP 10 FILES BY (visits × interest) ===",
    tableText,
    "=== END TABLE ===",
    "",
    "Produce your report-out now.",
  ].join("\n");

  // 2026-04-27: SSE-aware watchdog (see startSseAwareTurnWatchdog).
  const controller = new AbortController();
  const watchdog = startSseAwareTurnWatchdog({
    manager: host.manager,
    sessionId: lead.sessionId,
    controller,
    abortSession: async () => {},
  });
  try {
    // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
    const res = await promptWithFailoverAuto(lead, prompt, {
      signal: controller.signal,
      manager: host.manager,
      onTokens: ({ promptTokens, responseTokens }) => host.stats.recordTokens(lead.id, promptTokens, responseTokens),
      agentName: "swarm-read",
      // Phase 5b of #243: per-agent addendum from the topology row.
      promptAddendum: getAgentAddendum(host.active?.topology, lead.index),
      describeError: describeSdkError,
      onTiming: ({ attempt, elapsedMs, success }) => {
        host.stats.onTiming(lead.id, success, elapsedMs);
        host.manager.recordPromptComplete(lead.id, { attempt, elapsedMs, success });
        host.emit({
          type: "agent_latency_sample",
          agentId: lead.id,
          agentIndex: lead.index,
          attempt,
          elapsedMs,
          success,
          ts: Date.now(),
        });
      },
      onRetry: ({ attempt, max, reasonShort, delayMs }) => {
        host.stats.onRetry(lead.id);
        host.appendSystem(
          `[${lead.id}] transport error (${reasonShort}) — retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s`,
        );
      },
    });
    const diagCtx = {
      runner: "stigmergy",
      agentId: lead.id,
      agentIndex: lead.index,
      logDiag: host.logDiag,
      manager: host.manager,
      signal: controller.signal,
      runId: host.active?.runId,
    };
    const extracted = extractTextWithDiag(res, diagCtx);
    let text = extracted.text;
    if ((extracted.isEmpty || looksLikeJunk(text)) && !host.getStopping()) {
      const retryText = await retryEmptyResponse(lead, prompt, "swarm-read", diagCtx);
      if (retryText !== null) text = retryText;
    }
    // Task #115: track Pattern 8 stuck-loop, warn on threshold.
    trackPostRetryJunk(text, {
      agentId: lead.id,
      recordJunkPostRetry: (id, j) => host.stats.recordJunkPostRetry(id, j),
      appendSystem: (msg) => host.appendSystem(msg),
    });
    // Task #108: defensive guard — see CouncilRunner.runSynthesisPass.
    const isJunkSynthesis = looksLikeJunk(text) || extracted.isEmpty;
    // #230: strip <think> + XML pseudo-tool-call markers first.
    const stripped = finalizeAgentOutput(text, { role: "general" });
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: lead.id,
      agentIndex: lead.index,
      text: stripped.finalText || "(empty response)",
      ts: Date.now(),
      summary: isJunkSynthesis
        ? undefined
        : { kind: "stigmergy_report", filesRanked: ranked.length },
      ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
      ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
    };
    host.transcript.push(entry);
    host.emit({ type: "transcript_append", entry });
    if (isJunkSynthesis) {
      host.appendSystem(
        `[${lead.id}] stigmergy report-out text is degenerate (${text.length} chars) — kept in transcript but NOT tagged as canonical report.`,
      );
    }
  } catch (err) {
    host.appendSystem(
      `[${lead.id}] report-out failed (${err instanceof Error ? err.message : String(err)}); skipping synthesis.`,
    );
  } finally {
    watchdog.cancel();
    host.manager.markStatus(lead.id, "ready");
    host.emitAgentState({
      id: lead.id,
      index: lead.index,
      port: lead.port,
      sessionId: lead.sessionId,
      status: "ready",
      lastMessageAt: Date.now(),
    });
  }
}


export async function runExplorerTurn(
host: StigmergyTurnsHost,
agent: Agent,
  round: number,
  totalRounds: number,
  candidatePaths: readonly string[],
): Promise<void> {
  // Q8: optional saturation filter + decay-guided pick hint.
  let pathsForPrompt = candidatePaths;
  let decayHint: string | undefined;
  if (host.active?.pheromoneDecay) {
    const filtered = candidatePaths.filter((p) => {
      const st = host.annotations.get(p);
      if (!st) return true;
      return !isSaturated(st, DEFAULT_MAX_REVISITS);
    });
    pathsForPrompt = filtered.length > 0 ? filtered : candidatePaths;
    const pick = pickNextFileWithDecay({
      candidates: pathsForPrompt.map((path) => {
        const st = host.annotations.get(path);
        return {
          path,
          state: st ?? {
            visits: 0,
            avgInterest: 5,
            avgConfidence: 5,
            latestNote: "",
          },
          lastVisitedRound: st?.lastVisitedRound ?? null,
        };
      }),
      currentRound: round,
    });
    if (pick) {
      decayHint = pick.path;
      if (agent.index === 1 && round === 1) {
        host.appendSystem(
          `[Q8] Pheromone decay active — saturation cap ${DEFAULT_MAX_REVISITS}; decay-guided pick this turn: ${pick.path}`,
        );
      }
    }
  }

  // 2026-05-02 (improvement #1): compute recently-active files from
  // the last 1-2 rounds for the per-agent prompt. Surfaces the
  // dynamic peer-activity signal above the cumulative table.
  const recentlyActive: { file: string; round: number; note: string }[] = [];
  if (round > 1) {
    for (const [file, state] of host.annotations) {
      if (state.lastVisitedRound !== undefined && state.lastVisitedRound >= round - 2 && state.lastVisitedRound < round) {
        recentlyActive.push({
          file,
          round: state.lastVisitedRound,
          note: state.latestNote,
        });
      }
    }
    // Cap at top 5 by visits to keep the prompt focused
    recentlyActive.sort((a, b) => {
      const stateA = host.annotations.get(a.file);
      const stateB = host.annotations.get(b.file);
      return (stateB?.visits ?? 0) - (stateA?.visits ?? 0);
    });
    recentlyActive.length = Math.min(recentlyActive.length, 5);
  }
  const assignedTerritory = host.territoryAssignments.get(agent.index);
  const territory =
    assignedTerritory ??
    (decayHint ? `Prefer starting at ${decayHint} (decay-ranked, saturation-aware)` : undefined);
  const prompt = buildExplorerPrompt({
    agentIndex: agent.index,
    round,
    totalRounds,
    candidatePaths: pathsForPrompt,
    annotations: host.annotations,
    // 2026-05-02 (improvement #2): thread territory assignment from
    // the lead's pre-round-1 plan. Empty when plan failed.
    ...(territory ? { territory } : {}),
    ...(recentlyActive.length > 0 ? { recentlyActive } : {}),
  });
  // #303: parse the annotation INSIDE the runAgent transform so
  // the JSON envelope gets stripped from visible bubble text + the
  // entry carries a structured stigmergy_annotation summary the UI
  // bubble can render as a card. Capture the parsed annotation here
  // for the applyAnnotation call below.
  let parsedAnn: ParsedAnnotation | null = null;
  const text = await host.runAgent(agent, prompt, {
    transformEntry: (entryText) => {
      parsedAnn = parseAnnotation(entryText);
      if (!parsedAnn) return { text: entryText };
      const cleanText = stripAnnotationEnvelope(entryText);
      return {
        text: cleanText.length > 0 ? cleanText : entryText,
        summary: {
          kind: "stigmergy_annotation",
          file: parsedAnn.file,
          interest: parsedAnn.interest,
          confidence: parsedAnn.confidence,
          note: parsedAnn.note,
        },
      };
    },
  });
  if (host.getStopping() || !text) return;
  if (parsedAnn) {
    const ann = parsedAnn as ParsedAnnotation;
    host.applyAnnotation(ann);
    pheromoneHeatmap.updateFromAnnotations(host.annotations, host.round);
    host.appendSystem(
      `Annotation update — ${ann.file}: interest=${ann.interest}, confidence=${ann.confidence}, total visits=${host.annotations.get(ann.file)?.visits ?? 0}`,
    );
  } else {
    host.appendSystem(
      `[${agent.id}] no parseable annotation in response — agent's text kept in transcript but the pheromone table did not update for this turn.`,
    );
  }
}

