// Phase 9: per-run summary artifact. Pure shape-assembly function so the
// runner side stays testable. Types live in summaryTypes.ts.

import type { ExitContract } from "./types.js";
import { tokenTracker as tokenTrackerSingleton } from "../../services/ollamaProxy.js";
import { generateRca } from "../autoRca.js";
import { computeRunHealthScore } from "../runHealthScore.js";
import { collectStreamIntegrityReport } from "@ollama-swarm/shared/streamIntegrityReport";
export {
  FINAL_GIT_STATUS_MAX,
  TRANSCRIPT_MAX_ENTRIES,
  TERMINAL_QUOTA_MIN_ERRORS,
  type StopReason,
  type PerAgentStat,
  type RunSummary,
  type SummaryConfig,
  type SummaryCounts,
  type BuildSummaryInput,
} from "./summaryTypes.js";
import {
  FINAL_GIT_STATUS_MAX,
  TRANSCRIPT_MAX_ENTRIES,
  TERMINAL_QUOTA_MIN_ERRORS,
  TERMINAL_QUOTA_TRANSCRIPT_TAIL,
  type StopReason,
  type PerAgentStat,
  type RunSummary,
  type BuildSummaryInput,
} from "./summaryTypes.js";

export function detectTerminalQuotaExhaustion(
  input: Pick<BuildSummaryInput, "errors" | "agents" | "transcript">,
): string | null {
  const errors = input.errors ?? [];
  const quotaCount = errors.filter((e) => e.category === "quota").length;
  const successfulTurns = input.agents.reduce(
    (sum, a) => sum + (a.successfulAttempts ?? 0),
    0,
  );

  if (quotaCount >= TERMINAL_QUOTA_MIN_ERRORS && successfulTurns === 0) {
    return `terminal window: ${quotaCount} quota errors, zero successful agent turns`;
  }

  const tail = (input.transcript ?? [])
    .filter((e) => e.role === "system")
    .slice(-TERMINAL_QUOTA_TRANSCRIPT_TAIL);
  let streak = 0;
  let maxStreak = 0;
  for (const e of tail) {
    const text = e.text ?? "";
    if (
      /429|session usage limit|quota wall|rate.?limit|transport error.*retry/i.test(text)
    ) {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else if (!/\[control\]/i.test(text)) {
      streak = 0;
    }
  }
  if (maxStreak >= TERMINAL_QUOTA_MIN_ERRORS && successfulTurns <= 1) {
    return `terminal window: ${maxStreak} consecutive quota/transport failures, ${successfulTurns} successful turns`;
  }

  return null;
}

export function buildSummary(input: BuildSummaryInput): RunSummary {
  const wallClockMs = Math.max(0, input.endedAt - input.startedAt);
  const staleCount = input.board?.stale ?? 0;
  const ESTIMATED_MEAN_TURN_MS = 15_000; // conservative: stale turns average ~15s
  const wastedWallClockMs = staleCount * ESTIMATED_MEAN_TURN_MS;
  const { stopReason, stopDetail } = classifyStopReason(input);

  let finalGitStatus = input.finalGitStatus;
  let truncated = false;
  if (finalGitStatus.length > FINAL_GIT_STATUS_MAX) {
    finalGitStatus = finalGitStatus.slice(0, FINAL_GIT_STATUS_MAX);
    truncated = true;
  }

  // Task #163: accurate run-level token totals via tokenTracker.recent
  // filtered by ts in the run window. Independent of per-agent fields
  // (which are approximate for parallel paths).
  const { totalPromptTokens, totalResponseTokens } = computeRunTokenTotals(
    input.startedAt,
    input.endedAt,
    input.config.runId,
  );

  const streamIntegrity = collectStreamIntegrityReport(input.transcript);

  return {
    runId: input.config.runId,
    repoUrl: input.config.repoUrl,
    localPath: input.config.localPath,
    preset: input.config.preset,
    model: input.config.model,
    agentCount: input.agentCount,
    rounds: input.rounds,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    wallClockMs,
    wastedWallClockMs,
    stopReason,
    stopDetail,
    commits: input.board.committed,
    staleEvents: input.staleEvents,
    skippedTodos: input.board.skipped,
    totalTodos: input.board.total,
    filesChanged: input.filesChanged,
    finalGitStatus,
    finalGitStatusTruncated: truncated,
    totalPromptTokens,
    totalResponseTokens,
    ...(streamIntegrity ? { streamIntegrity } : {}),
    ...(input.applyIntegrity ? { applyIntegrity: { ...input.applyIntegrity, missByKind: { ...input.applyIntegrity.missByKind } } } : {}),
    ...(input.cycleIntegrity
      ? {
          cycleIntegrity: {
            ...input.cycleIntegrity,
            failByBucket: { ...input.cycleIntegrity.failByBucket },
          },
        }
      : {}),
    agents: input.agents.slice(),
    contract: input.contract ? cloneContract(input.contract) : undefined,
    // Task #65: cap transcript at TRANSCRIPT_MAX_ENTRIES (head) so a
    // pathological run doesn't blow the summary file. transcriptTruncated
    // surfaces in the modal for honesty.
    ...(() => {
      const t = input.transcript;
      if (!t || t.length === 0) return {};
      if (t.length > TRANSCRIPT_MAX_ENTRIES) {
        return { transcript: t.slice(0, TRANSCRIPT_MAX_ENTRIES), transcriptTruncated: true };
      }
      return { transcript: t.slice() };
    })(),
    // Unit 34: ambition ratchet passthrough.
    maxTierReached: input.maxTierReached,
    tiersCompleted: input.tiersCompleted,
    tierHistory: input.tierHistory ? input.tierHistory.map((t) => ({ ...t })) : undefined,
    // V2 Step 3b.2: parallel-track reducer state passthrough.
    v2State: input.v2State,
    // V2 Step 5c.1: parallel-track TodoQueue state passthrough.
    v2QueueState: input.v2QueueState,
    // Phase 4a of #243: topology passthrough.
    topology: input.topology,
    // Phase 10: phase state (currentPhase/phases) no longer forwarded from input.
    // R15 + R16 wiring (2026-05-04): post-build RCA + health score.
    // R17 wiring (2026-05-04): now consumes input.errors when the
    // runner has collected ClassifiedError records — falls back to []
    // when not, matching the pre-tracker first cut.
    rca: buildRca({ input, stopReason, wallClockMs }),
    healthScore: buildHealthScore({ input, wallClockMs }),
    // Deliverables: extract created/modified files from git porcelain.
    deliverables: input.deliverables ?? extractDeliverables(input.finalGitStatus),
    startCommand: input.config.startCommand,
    ...(input.config.userDirective ? { userDirective: input.config.userDirective } : {}),
    ...(input.config.plannerTools !== undefined ? { plannerTools: input.config.plannerTools } : {}),
    ...(input.config.webTools !== undefined ? { webTools: input.config.webTools } : {}),
    ...(input.controlAdvice?.length ? { controlAdvice: input.controlAdvice.slice() } : {}),
  };
}

/** Extract deliverables (created/modified files) from git porcelain output.
 *  The porcelain format is: XY PATH\n where X is index status, Y is worktree
 *  status. We treat A (added) and ? (untracked) as "created"; everything
 *  else as "modified". Cap at 50 entries to keep the summary bounded. */
export function extractDeliverables(
  porcelain: string,
): Array<{ path: string; status: "created" | "modified" }> | undefined {
  if (!porcelain || porcelain.trim().length === 0) return undefined;
  const DELIVERABLES_MAX = 50;
  const lines = porcelain.trim().split("\n");
  const result: Array<{ path: string; status: "created" | "modified" }> = [];
  for (const line of lines) {
    if (result.length >= DELIVERABLES_MAX) break;
    // Porcelain format: XY PATH or XY ORIG_PATH -> PATH
    // X = index status, Y = worktree status
    const x = line.charAt(0);
    const pathStart = line.indexOf(" ", 2);
    const filePath = pathStart >= 0 ? line.slice(pathStart + 1).trim() : line.slice(3).trim();
    if (!filePath) continue;
    const status: "created" | "modified" = (x === "A" || x === "?" || x === "a") ? "created" : "modified";
    result.push({ path: filePath, status });
  }
  return result.length > 0 ? result : undefined;
}

function buildRca(args: {
  input: BuildSummaryInput;
  stopReason: StopReason;
  wallClockMs: number;
}): import("../autoRca.js").RcaReport {
  const { input, stopReason, wallClockMs } = args;
  // Map StopReason → finalPhase for the RCA generator. Crashes /
  // caps surface as "failed"; user stops as "stopped"; clean done
  // as "completed". "crashed" for hard kills same as crash.
  let finalPhase: string;
  if (stopReason === "completed") finalPhase = "completed";
  else if (stopReason === "user") finalPhase = "stopped";
  else if (stopReason === "crash" || stopReason === "crashed") finalPhase = "failed";
  else finalPhase = "failed";
  return generateRca({
    finalPhase,
    terminationReason: input.terminationReason ?? input.crashMessage ?? null,
    errors: input.errors ?? [],
    commitsLanded: input.board.committed,
    tier: input.maxTierReached ?? 0,
    durationMs: wallClockMs,
  });
}

function buildHealthScore(args: {
  input: BuildSummaryInput;
  wallClockMs: number;
}): import("../runHealthScore.js").RunHealthScore {
  const { input, wallClockMs } = args;
  const totalTurns = input.agents.reduce(
    (s, a) => s + (a.turnsTaken ?? 0),
    0,
  );
  const retryCount = input.agents.reduce(
    (s, a) => s + (a.totalRetries ?? 0),
    0,
  );
  // Empty-turn proxy: jsonRepairs + promptErrors per agent. Not
  // exact (a JSON repair can succeed → not actually empty) but
  // captures the same "model didn't engage" signal.
  const emptyTurns = input.agents.reduce(
    (s, a) => s + (a.jsonRepairs ?? 0) + (a.promptErrors ?? 0),
    0,
  );
  return computeRunHealthScore({
    commitsLanded: input.board.committed,
    tier: input.maxTierReached ?? 0,
    totalTurns,
    emptyTurns,
    retryCount,
    durationMs: wallClockMs,
    wallClockCapMs: 0,
    commitsCap: 0,
    errorCount: input.errors?.length ?? 0,
  });
}

function cloneContract(c: ExitContract): ExitContract {
  return {
    missionStatement: c.missionStatement,
    criteria: c.criteria.map((crit) => ({
      ...crit,
      expectedFiles: [...crit.expectedFiles],
    })),
  };
}

/** Align with autoRca FAST_DEATH_MS — sub-threshold runs with zero work are failures. */
export const STARTUP_ABORT_MAX_MS = 30_000;

const STARTUP_ACTIVITY_RE =
  /Goal-generation pre-pass|research pre-pass|goal analysis|web research|Planner agent .* ready/i;

/** User pressed Stop/Drain, or V2 reducer / error tracker recorded the request. */
export function isUserInitiatedStop(
  input: Pick<
    BuildSummaryInput,
    "stopping" | "userStopRequested" | "wasDrained" | "v2State" | "errors"
  >,
): boolean {
  if (input.stopping || input.userStopRequested || input.wasDrained) return true;
  const detail = input.v2State?.detail;
  if (detail === "user-stop" || detail === "drain-requested") return true;
  return (input.errors ?? []).some((e) => e.category === "user-stop");
}

function hasStartupWorkEvidence(
  input: Pick<BuildSummaryInput, "transcript" | "v2State" | "agents">,
): boolean {
  if (input.v2State?.detail === "user-stop" || input.v2State?.detail === "drain-requested") {
    return true;
  }
  const transcript = input.transcript ?? [];
  if (transcript.some((e) => e.role === "agent")) return true;
  if (transcript.some((e) => e.role === "system" && STARTUP_ACTIVITY_RE.test(e.text))) {
    return true;
  }
  return input.agents.some(
    (a) => (a.tokensIn ?? 0) > 0 || (a.tokensOut ?? 0) > 0,
  );
}

export function isStartupAbort(
  input: Pick<
    BuildSummaryInput,
    | "startedAt"
    | "endedAt"
    | "stopping"
    | "userStopRequested"
    | "wasDrained"
    | "terminationReason"
    | "board"
    | "agents"
    | "transcript"
    | "v2State"
    | "errors"
  >,
): boolean {
  if (!isUserInitiatedStop(input) || input.terminationReason) return false;
  if (hasStartupWorkEvidence(input)) return false;
  const wallClockMs = Math.max(0, input.endedAt - input.startedAt);
  if (wallClockMs >= STARTUP_ABORT_MAX_MS) return false;
  const noBoard =
    (input.board?.total ?? 0) === 0 && (input.board?.committed ?? 0) === 0;
  if (!noBoard) return false;
  return (
    input.agents.length === 0 ||
    input.agents.every((a) => (a.turnsTaken ?? 0) === 0)
  );
}

function classifyStopReason(
  input: Pick<
    BuildSummaryInput,
    | "startedAt"
    | "endedAt"
    | "crashMessage"
    | "terminationReason"
    | "stopping"
    | "userStopRequested"
    | "wasDrained"
    | "completionDetail"
    | "board"
    | "contract"
    | "agents"
    | "transcript"
    | "v2State"
    | "errors"
  >,
): { stopReason: StopReason; stopDetail?: string } {
  if (input.crashMessage) {
    return { stopReason: "crash", stopDetail: input.crashMessage };
  }
  if (input.terminationReason) {
    const capType = parseCapType(input.terminationReason);
    return { stopReason: capType, stopDetail: input.terminationReason };
  }
  if (isUserInitiatedStop(input)) {
    if (isStartupAbort(input)) {
      return {
        stopReason: "crash",
        stopDetail:
          "ended during startup with zero progress (no agent turns, no commits)",
      };
    }
    return { stopReason: "user" };
  }
  const quotaDetail = detectTerminalQuotaExhaustion(input);
  if (quotaDetail) {
    return { stopReason: "cap:quota", stopDetail: quotaDetail };
  }
  // Zero-progress detector — see top-of-file priority list. Catches the
  // "planner returned 0 valid todos and the run gracefully wound down"
  // pattern that previously masqueraded as a successful completion.
  // Conditions: contract had real criteria; none flipped to met; board
  // saw zero todos AND zero commits.
  const criteria = input.contract?.criteria ?? [];
  const hadCriteria = criteria.length > 0;
  const allUnmet = hadCriteria && criteria.every((c) => c.status === "unmet");
  const hasUnmet = hadCriteria && criteria.some((c) => c.status === "unmet");
  const noBoardActivity = input.board.total === 0 && input.board.committed === 0;
  if (allUnmet && noBoardActivity) {
    return {
      stopReason: "no-progress",
      stopDetail:
        input.completionDetail ??
        "planner produced no actionable todos; no commits and all criteria still unmet",
    };
  }
  // Blackboard planning failed before any contract/todos landed (e.g. tool-loop
  // cap on contract emit + planner-todos). Without this, runs masquerade as
  // "completed" when the board never received work.
  if (!hadCriteria && noBoardActivity && input.completionDetail) {
    return {
      stopReason: "no-progress",
      stopDetail: input.completionDetail,
    };
  }
  if (
    hasUnmet
    && input.completionDetail?.includes("no new work")
  ) {
    return {
      stopReason: "no-progress",
      stopDetail: input.completionDetail,
    };
  }
  // Productive-progress / stuck gates set completionDetail without terminationReason.
  // Must not classify as "completed" or the UI banner hides the real stop.
  if (input.completionDetail) {
    const d = input.completionDetail;
    if (
      /no-productive-progress|no new work|unresolved criteria remain|tier-stuck|audit-stuck|attempts-exhausted|noop-exhausted|produced no actionable/i.test(
        d,
      )
    ) {
      return { stopReason: "no-progress", stopDetail: d };
    }
    if (
      /cap:|wall-clock|token budget|quota/i.test(d)
    ) {
      const capType = parseCapType(d);
      return { stopReason: capType, stopDetail: d };
    }
    if (/pipeline phase|ambition-failed|planner-fallback/i.test(d)) {
      return { stopReason: "early-stop", stopDetail: d };
    }
  }
  // Partial progress: some criteria met, some wont-do, rest unresolvable.
  // The wont-do ones mean the auditor explicitly gave up on them.
  const hasWontDo = hadCriteria && criteria.some((c) => c.status === "wont-do");
  const someMet = hadCriteria && criteria.some((c) => c.status === "met");
  if (hasWontDo && someMet && !hasUnmet) {
    return {
      stopReason: "partial-progress",
      stopDetail: input.completionDetail,
    };
  }
  return { stopReason: "completed", stopDetail: input.completionDetail };
}

// Unit 21: small pure helper for per-agent latency stats. Returns
// p50/p95/mean over the given samples or null when empty (so the
// summary doesn't lie about an agent that never produced a successful
// attempt). Sort is non-mutating.
export interface LatencyStats {
  mean: number | null;
  p50: number | null;
  p95: number | null;
}
export function computeLatencyStats(samplesMs: readonly number[]): LatencyStats {
  if (samplesMs.length === 0) return { mean: null, p50: null, p95: null };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  // Nearest-rank percentile: ceil(p * N / 100) - 1, clamped to [0, N-1].
  const at = (p: number): number => {
    const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
    return sorted[rank - 1];
  };
  return {
    mean: Math.round(sum / sorted.length),
    p50: at(50),
    p95: at(95),
  };
}

/**
 * Run-scoped token totals from the usage ledger (tokenTracker).
 *
 * Prefer `runId` filter so concurrent runs never pollute each other.
 * Time window is a secondary bound (startedAt → endedAt + grace).
 * Optional `tracker` for tests.
 */
export function computeRunTokenTotals(
  startedAt: number,
  endedAt: number,
  trackerOrRunId?:
    | { recent: (n: number) => ReadonlyArray<{ ts: number; promptTokens: number; responseTokens: number; runId?: string }> }
    | string,
  maybeRunId?: string,
): { totalPromptTokens: number; totalResponseTokens: number } {
  let tracker: {
    recent: (n: number) => ReadonlyArray<{
      ts: number;
      promptTokens: number;
      responseTokens: number;
      runId?: string;
    }>;
  };
  let runId: string | undefined;
  if (typeof trackerOrRunId === "string") {
    tracker = tokenTrackerSingleton;
    runId = trackerOrRunId;
  } else if (trackerOrRunId && typeof trackerOrRunId === "object" && "recent" in trackerOrRunId) {
    tracker = trackerOrRunId;
    runId = maybeRunId;
  } else {
    tracker = tokenTrackerSingleton;
    runId = maybeRunId;
  }

  const grace = 5_000;
  const lo = startedAt;
  const hi = endedAt + grace;
  const recent = tracker.recent(10_000);
  let p = 0;
  let r = 0;
  for (const rec of recent) {
    if (rec.ts < lo || rec.ts > hi) continue;
    if (runId && rec.runId && rec.runId !== runId) continue;
    // When runId is requested but record has no runId (legacy/proxy),
    // only count if we're not filtering strictly — prefer strict when
    // any run-scoped records exist for this run.
    if (runId && !rec.runId) continue;
    p += rec.promptTokens;
    r += rec.responseTokens;
  }
  // Fallback: if runId filter found nothing, use time window only
  // (legacy records without runId attribution).
  if (runId && p + r === 0) {
    for (const rec of recent) {
      if (rec.ts < lo || rec.ts > hi) continue;
      if (rec.runId && rec.runId !== runId) continue;
      p += rec.promptTokens;
      r += rec.responseTokens;
    }
  }
  return { totalPromptTokens: p, totalResponseTokens: r };
}

function parseCapType(reason: string): StopReason {
  // Keep in sync with caps.ts reason strings. Anything unrecognized gets
  // bucketed as wall-clock since that's the original cap and least wrong.
  if (reason.startsWith("wall-clock cap")) return "cap:wall-clock";
  if (reason.startsWith("commits cap")) return "cap:commits";
  if (reason.startsWith("todos cap")) return "cap:todos";
  if (reason.startsWith("token-budget")) return "cap:tokens";
  // Task #158: #137's quota-wall reason ("ollama-quota-exhausted (NNN: ...)")
  // was previously falling through to cap:wall-clock — misleading. Surface
  // it as its own bucket so summaries / UI can color it distinctly.
  if (reason.startsWith("ollama-quota-exhausted")) return "cap:quota";
  return "cap:wall-clock";
}
