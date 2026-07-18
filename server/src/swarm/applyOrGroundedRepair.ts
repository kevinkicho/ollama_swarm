/**
 * Shared apply → grounded repair → re-apply core (RR-A / RR-B).
 * Callers supply model invoke; this module stays free of runner types.
 *
 * Deterministic uniqueCandidates[0] is tried before the LLM by default
 * (83dc5910: 25/32 search_not_found with repairFailures=24 when opt-in only).
 * Set SWARM_APPLY_DETERMINISTIC_CANDIDATE=0 to disable.
 */

import {
  applyHunks,
  type ApplyMissReport,
  type Hunk,
} from "./blackboard/applyHunks.js";
import { countOccurrences } from "./blackboard/applyMissReport.js";
import {
  buildHunkRepairPrompt,
  isRepairableApplyMiss,
  parseWorkerResponse,
} from "./blackboard/prompts/worker.js";

export type ApplyPath =
  | "council"
  | "blackboard_preflight"
  | "auditor"
  | "wrapup"
  | "propose_hunks";

export interface ApplyOrGroundedRepairInput {
  hunks: Hunk[];
  currentTextsByFile: Record<string, string | null>;
  expectedFiles: string[];
  /** Re-read a file after miss (fresh disk). */
  readFile?: (path: string) => Promise<string | null>;
  /** Emit-only model call that returns raw text. */
  callModel: (repairPrompt: string) => Promise<string>;
  maxGroundedRepairs?: number;
  /**
   * When true, or when unset and env is not explicitly off, try
   * uniqueCandidates[0] as search/start rewrite before calling the model.
   * Only for search_not_found / start_not_found when candidate is unique.
   * Pass false to force-disable for a single call.
   */
  tryDeterministicCandidate?: boolean;
  /** Env bag for flag (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface ApplyOrGroundedRepairResult {
  ok: boolean;
  newTextsByFile?: Record<string, string>;
  hunks?: Hunk[];
  error?: string;
  /** Last miss (present on failure; also set when repaired after a miss). */
  miss?: ApplyMissReport;
  repaired: boolean;
  repairAttempts: number;
  /** True when uniqueCandidates[0] rewrite applied without LLM. */
  deterministicCandidate?: boolean;
}

/**
 * Deterministic uniqueCandidates[0] try — **default ON**.
 * Disable with SWARM_APPLY_DETERMINISTIC_CANDIDATE=0|false|no|off.
 */
export function isDeterministicCandidateEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = (env.SWARM_APPLY_DETERMINISTIC_CANDIDATE ?? "1").trim();
  if (v === "") return true;
  return !/^(0|false|no|off)$/i.test(v);
}

/**
 * Rewrite the failed hunk's search/start to a unique candidate string.
 * Pass a single candidate (caller iterates uniqueCandidates).
 */
export function rewriteHunkWithCandidate(
  hunks: Hunk[],
  miss: ApplyMissReport,
  fileText: string,
  candidateIndex = 0,
): Hunk[] | null {
  if (
    miss.kind !== "search_not_found" &&
    miss.kind !== "start_not_found"
  ) {
    return null;
  }
  const cand = miss.uniqueCandidates[candidateIndex]?.trim();
  if (!cand || cand.length < 8) return null;
  if (countOccurrences(fileText, cand) !== 1) return null;

  const idx = miss.hunkIndex;
  if (idx < 0 || idx >= hunks.length) return null;
  const h = hunks[idx]!;
  if (h.file !== miss.file) return null;

  if (h.op === "replace" && miss.kind === "search_not_found") {
    return hunks.map((x, i) =>
      i === idx ? { ...h, search: cand } : x,
    );
  }
  if (h.op === "replace_between" && miss.kind === "start_not_found") {
    return hunks.map((x, i) =>
      i === idx ? { ...h, start: cand } : x,
    );
  }
  return null;
}

/**
 * Apply hunks; on repairable miss, optional deterministic candidate then
 * one (default) grounded repair re-emit + re-apply.
 * Never returns ok with the original failed hunks.
 */
export async function applyOrGroundedRepair(
  input: ApplyOrGroundedRepairInput,
): Promise<ApplyOrGroundedRepairResult> {
  const maxRepairs = Math.max(0, input.maxGroundedRepairs ?? 1);
  let hunks = input.hunks.slice();
  let texts = { ...input.currentTextsByFile };
  let repairAttempts = 0;
  let usedDeterministic = false;

  let applied = applyHunks(texts, hunks);
  if (applied.ok) {
    return {
      ok: true,
      newTextsByFile: applied.newTextsByFile,
      hunks,
      repaired: false,
      repairAttempts: 0,
    };
  }

  // Capture fail fields (nested closures won't narrow `applied` correctly).
  let lastError = applied.error;
  let lastMiss = applied.miss;

  // Fresh disk for miss file before any recovery.
  async function refreshMissFile(miss: ApplyMissReport | undefined): Promise<string | null> {
    const failedFile =
      miss?.file ||
      lastError.match(/file "([^"]+)"/)?.[1] ||
      input.expectedFiles[0];
    if (!failedFile) return null;
    let content = texts[failedFile] ?? null;
    if (input.readFile) {
      try {
        const fresh = await input.readFile(failedFile);
        if (fresh != null) content = fresh;
      } catch {
        /* keep */
      }
    }
    if (content != null) {
      texts = { ...texts, [failedFile]: content };
    }
    return content;
  }

  // RR-B: deterministic uniqueCandidates (try each unique one) before LLM.
  const wantDet =
    input.tryDeterministicCandidate === true ||
    (input.tryDeterministicCandidate !== false &&
      isDeterministicCandidateEnabled(input.env ?? process.env));

  const firstMiss = lastMiss;

  if (
    wantDet &&
    lastMiss &&
    isRepairableApplyMiss({ miss: lastMiss, reason: lastError })
  ) {
    const content = await refreshMissFile(lastMiss);
    if (content != null && lastMiss) {
      const nCands = lastMiss.uniqueCandidates?.length ?? 0;
      // Try each unique candidate (not only [0]) — 120b HTML thrash often
      // had a usable later candidate while [0] was wrong.
      for (let ci = 0; ci < nCands; ci++) {
        const rewritten = rewriteHunkWithCandidate(hunks, lastMiss, content, ci);
        if (!rewritten) continue;
        const det = applyHunks(texts, rewritten);
        if (det.ok) {
          return {
            ok: true,
            newTextsByFile: det.newTextsByFile,
            hunks: rewritten,
            miss: firstMiss,
            repaired: true,
            repairAttempts: 0,
            deterministicCandidate: true,
          };
        }
      }
      // Fall through to LLM with original miss
    }
  }

  while (
    repairAttempts < maxRepairs &&
    isRepairableApplyMiss({ miss: lastMiss, reason: lastError })
  ) {
    const miss = lastMiss;
    const failedFile =
      miss?.file ||
      lastError.match(/file "([^"]+)"/)?.[1] ||
      input.expectedFiles[0];
    if (!failedFile) break;

    const content = await refreshMissFile(miss);
    if (content == null) break;

    const prompt = buildHunkRepairPrompt(
      hunks,
      lastError,
      { [failedFile]: content },
      { miss },
    );
    repairAttempts += 1;
    let raw: string;
    try {
      raw = await input.callModel(prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `${lastError} | repair model failed: ${msg}`,
        miss,
        repaired: false,
        repairAttempts,
        deterministicCandidate: usedDeterministic,
      };
    }

    const parsed = parseWorkerResponse(raw, input.expectedFiles);
    if (!parsed.ok || parsed.skip || parsed.hunks.length === 0) {
      return {
        ok: false,
        error: lastError + " | repair parse failed",
        miss,
        repaired: false,
        repairAttempts,
        deterministicCandidate: usedDeterministic,
      };
    }

    hunks = parsed.hunks as Hunk[];
    applied = applyHunks(texts, hunks);
    if (applied.ok) {
      return {
        ok: true,
        newTextsByFile: applied.newTextsByFile,
        hunks,
        miss: firstMiss,
        repaired: true,
        repairAttempts,
        deterministicCandidate: usedDeterministic,
      };
    }
    lastError = applied.error;
    lastMiss = applied.miss;
  }

  return {
    ok: false,
    error: lastError,
    miss: lastMiss,
    repaired: false,
    repairAttempts,
    deterministicCandidate: usedDeterministic,
  };
}
