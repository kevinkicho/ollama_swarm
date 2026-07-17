/**
 * Shared apply → grounded repair → re-apply core (RR-A).
 * Callers supply model invoke; this module stays free of runner types.
 */

import {
  applyHunks,
  type ApplyMissReport,
  type Hunk,
} from "./blackboard/applyHunks.js";
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
}

export interface ApplyOrGroundedRepairResult {
  ok: boolean;
  newTextsByFile?: Record<string, string>;
  hunks?: Hunk[];
  error?: string;
  miss?: ApplyMissReport;
  repaired: boolean;
  repairAttempts: number;
}

/**
 * Apply hunks; on repairable miss, one (default) grounded repair re-emit + re-apply.
 * Never returns ok with the original failed hunks.
 */
export async function applyOrGroundedRepair(
  input: ApplyOrGroundedRepairInput,
): Promise<ApplyOrGroundedRepairResult> {
  const maxRepairs = Math.max(0, input.maxGroundedRepairs ?? 1);
  let hunks = input.hunks.slice();
  let texts = { ...input.currentTextsByFile };
  let repairAttempts = 0;

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

  while (
    repairAttempts < maxRepairs &&
    isRepairableApplyMiss({ miss: applied.miss, reason: applied.error })
  ) {
    const miss = applied.miss;
    const failedFile =
      miss?.file ||
      applied.error.match(/file "([^"]+)"/)?.[1] ||
      input.expectedFiles[0];
    if (!failedFile) break;

    let content = texts[failedFile] ?? null;
    if (input.readFile) {
      try {
        const fresh = await input.readFile(failedFile);
        if (fresh != null) content = fresh;
      } catch {
        /* keep */
      }
    }
    if (content == null) break;

    texts = { ...texts, [failedFile]: content };
    const prompt = buildHunkRepairPrompt(
      hunks,
      applied.error,
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
        error: `${applied.error} | repair model failed: ${msg}`,
        miss,
        repaired: false,
        repairAttempts,
      };
    }

    const parsed = parseWorkerResponse(raw, input.expectedFiles);
    if (!parsed.ok || parsed.skip || parsed.hunks.length === 0) {
      return {
        ok: false,
        error: applied.error + " | repair parse failed",
        miss,
        repaired: false,
        repairAttempts,
      };
    }

    hunks = parsed.hunks as Hunk[];
    applied = applyHunks(texts, hunks);
    if (applied.ok) {
      return {
        ok: true,
        newTextsByFile: applied.newTextsByFile,
        hunks,
        repaired: true,
        repairAttempts,
      };
    }
  }

  return {
    ok: false,
    error: applied.error,
    miss: applied.miss,
    repaired: false,
    repairAttempts,
  };
}
