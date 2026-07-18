/**
 * Council worker literature pre-pass (web_search/web_fetch before hunk emit).
 * Extracted from councilWorkerRunner for LOC hygiene + unit-testability.
 */

import type { Agent } from "../services/AgentManager.js";
import type { QueuedTodo } from "./blackboard/TodoQueue.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import { chatOnce } from "./chatOnce.js";
import { extractText } from "./extractText.js";
import { isWebToolsEnabled } from "./toolProfiles.js";
import { isLiteratureTodo } from "./blackboard/prompts/worker.js";
import { buildResearchToolsNote } from "./blackboard/prompts/planner.js";
import { makeBufferedToolHandler } from "./toolCallTranscript.js";
import { isUsableResearchBrief } from "./researchBrief.js";
import { localCatalogNotesOnResearchFail } from "./research/localCatalogIndex.js";
import {
  isResearchBlackout,
  noteCatalogInject,
  noteResearchAttempt,
  noteResearchFailure,
  noteResearchSuccess,
  getResearchBlackoutReason,
} from "./research/researchBudget.js";
import {
  EXPLORE_MAX_LITERATURE_TOOL_TURNS,
  LITERATURE_RESEARCH_NUDGE_MESSAGE,
  LITERATURE_RESEARCH_NUDGE_TURN,
  LITERATURE_RESEARCH_PROFILE,
  LITERATURE_RESEARCH_TOOLS,
} from "../../../shared/src/toolProfiles.js";

/** Consecutive literature failures before run-wide blackout (legacy adapter mirror). */
const LITERATURE_BLACKOUT_AFTER = 3;

/**
 * Research pre-pass for literature todos. Cached per-todo; repair/failover
 * should pass opts.skip so web tools are not re-burned.
 */
export async function runCouncilLiteratureResearch(
  state: CouncilAdapterState,
  agent: Agent,
  todo: QueuedTodo,
  appendSystem: (msg: string) => void,
  signal?: AbortSignal,
  opts?: { skip?: boolean },
): Promise<string | undefined> {
  if (opts?.skip || signal?.aborted) return undefined;
  const cfg = state.cfg;
  if (!isWebToolsEnabled(cfg) || !isLiteratureTodo(todo.description)) {
    return undefined;
  }

  // Per-todo cache: primary/repair/failover share one research pass (eee6718f).
  const cache = state.literatureNotesByTodoId ?? (state.literatureNotesByTodoId = new Map());
  if (cache.has(todo.id)) {
    const cached = cache.get(todo.id);
    return cached ?? undefined;
  }

  // Run-level blackout: prefer shared researchBudget (RR-C) + legacy adapter field.
  const blackout = state.researchBlackout ?? (state.researchBlackout = {
    consecutiveFailures: 0,
    active: false,
  });
  const runId = cfg.runId;

  // RR-C local-first (parity with blackboard): score-gated catalog before web.
  // Live eee6718f burned tool loops on panel/API todos that already had catalogs.
  let localFirst =
    localCatalogNotesOnResearchFail(todo.description, state.clonePath) || "";
  try {
    const { tryLocalFirstCatalog } = await import("./research/localCatalogIndex.js");
    const hit = tryLocalFirstCatalog(todo.description, state.clonePath);
    if (hit) {
      noteCatalogInject(runId);
      appendSystem(
        `[${agent.id}] Local catalog (local-first score=${hit.bestScore}): ` +
          `injected ${hit.notes.length} chars — skipping web literature pre-pass.`,
      );
      const capped =
        hit.notes.length > 8000 ? `${hit.notes.slice(0, 8000)}…` : hit.notes;
      cache.set(todo.id, capped);
      return capped;
    }
  } catch {
    if (localFirst.length >= 200) {
      noteCatalogInject(runId);
      appendSystem(
        `[${agent.id}] Local catalog (local-first): injected ${localFirst.length} chars — skipping web literature pre-pass.`,
      );
      const capped =
        localFirst.length > 8000 ? `${localFirst.slice(0, 8000)}…` : localFirst;
      cache.set(todo.id, capped);
      return capped;
    }
  }

  // Single source of truth: researchBudget (legacy blackout field is mirror only).
  if (isResearchBlackout(runId) || blackout.active) {
    if (isResearchBlackout(runId) && !blackout.active) {
      blackout.active = true;
      blackout.lastReason = getResearchBlackoutReason(runId);
    }
    const why =
      getResearchBlackoutReason(runId) ||
      blackout.lastReason ||
      "research blackout";
    appendSystem(
      `[${agent.id}] Literature research skipped (run blackout: ${why.slice(0, 80)}) — using local tools only.`,
    );
    if (localFirst) {
      noteCatalogInject(runId);
      appendSystem(
        `[${agent.id}] Local catalog: injected ${localFirst.length} chars of endpoint notes (blackout path).`,
      );
      cache.set(todo.id, localFirst);
      return localFirst;
    }
    cache.set(todo.id, null);
    return undefined;
  }

  (state.manager as {
    markStatus: (id: string, status: string, extra?: Record<string, unknown>) => void;
  }).markStatus(agent.id, "thinking", {
    activityKind: "worker",
    activityLabel: "literature research",
    thinkingSince: Date.now(),
  });
  const prompt = [
    "You are a research worker gathering sources BEFORE writing file edits.",
    buildResearchToolsNote(true),
    "",
    `TODO: ${todo.description}`,
    `Target files: ${todo.expectedFiles.join(", ")}`,
    cfg.userDirective ? `User directive: ${cfg.userDirective}` : "",
    "",
    "Prefer clone docs (API_ENDPOINTS, GOVERNMENT_API_CATALOG, PANELS) via read/grep before web_search.",
    "Use web_search and web_fetch to gather citable findings. Output plain prose with bullet points and URLs.",
    "If search backends fail, stop tool use immediately and say so — do not retry the same query.",
    "Do NOT emit JSON hunks in this phase.",
  ].filter(Boolean).join("\n");

  noteResearchAttempt(runId);
  try {
    // Literature is tool-heavy; keep budget tight so thrash fails fast.
    const litToolTurns = Math.min(EXPLORE_MAX_LITERATURE_TOOL_TURNS, 8);
    const res = await chatOnce(agent, {
      agentName: LITERATURE_RESEARCH_PROFILE,
      promptText: prompt,
      clonePath: state.clonePath,
      webToolsConfig: cfg,
      runId: cfg.runId,
      mcpServers: cfg.mcpServers,
      signal,
      manager: state.manager as any,
      activity: { kind: "worker", label: "literature research" },
      maxToolTurns: litToolTurns,
      toolsOverride: [...LITERATURE_RESEARCH_TOOLS] as const,
      toolLoopNudge: {
        atTurn: Math.min(LITERATURE_RESEARCH_NUDGE_TURN, 4),
        message: LITERATURE_RESEARCH_NUDGE_MESSAGE,
      },
      onTool: makeBufferedToolHandler(state.pendingToolTraceByAgent, agent.id),
      // Shorter wall for literature — 120s idle was common on eee6718f.
      promptWallClockMs: 90_000,
    });
    const text = extractText(res)?.trim();
    if (text && isUsableResearchBrief(text)) {
      const capped = text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
      appendSystem(`[${agent.id}] Literature research: captured ${capped.length} chars of notes.`);
      blackout.consecutiveFailures = 0;
      noteResearchSuccess(runId);
      cache.set(todo.id, capped);
      return capped;
    }
    if (text && text.length >= 80) {
      appendSystem(
        `[${agent.id}] Literature research: rejected output (need prose notes with URLs, not JSON hunks or intent-only stubs).`,
      );
    }
    blackout.consecutiveFailures += 1;
    blackout.lastReason = "unusable brief";
    const { blackoutJustActivated } = noteResearchFailure("unusable brief", runId);
    if (blackoutJustActivated) blackout.active = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendSystem(`[${agent.id}] Literature research failed: ${msg}`);
    blackout.consecutiveFailures += 1;
    blackout.lastReason = msg.slice(0, 160);
    const { blackoutJustActivated } = noteResearchFailure(msg, runId);
    if (blackoutJustActivated) blackout.active = true;
  }

  if (blackout.consecutiveFailures >= LITERATURE_BLACKOUT_AFTER || isResearchBlackout(runId)) {
    blackout.active = true;
    appendSystem(
      `[research] Run-level literature blackout after ${blackout.consecutiveFailures} consecutive failures — ` +
        `further web research pre-passes skipped; workers use local read/grep only.`,
    );
  }

  // Hard search / unusable brief: fall back to local endpoint catalog (zero network).
  const localNotes = localCatalogNotesOnResearchFail(todo.description, state.clonePath);
  if (localNotes) {
    noteCatalogInject(runId);
    appendSystem(
      `[${agent.id}] Local catalog: injected ${localNotes.length} chars of endpoint notes (literature fail path).`,
    );
    cache.set(todo.id, localNotes);
    return localNotes;
  }

  cache.set(todo.id, null);
  return undefined;
}
