import { looksLikeAlreadyDoneSkip, looksLikeOutOfScopeSkip } from "./stallRules.js";

export interface SkipGroundingInput {
  reason: string;
  expectedFiles: readonly string[];
  fileContents: Readonly<Record<string, string | null>>;
  unmetCriteriaCount: number;
}

export type SkipGroundingVerdict =
  | { allow: true }
  | { allow: false; blockReason: string };

function missingExpectedFiles(
  expectedFiles: readonly string[],
  fileContents: Readonly<Record<string, string | null>>,
): string[] {
  const missing: string[] = [];
  for (const f of expectedFiles) {
    const content = fileContents[f];
    if (content === null || content === undefined) missing.push(f);
  }
  return missing;
}

function hasTestPath(files: readonly string[]): boolean {
  return files.some((f) => /(^|\/)__(tests?)__\//i.test(f) || /\.test\.(tsx?|jsx?)$/i.test(f));
}

/**
 * Rule-based gate before accepting a replanner skip.
 * Blocks "already done" / "out of scope" skips when disk evidence disagrees.
 */
export function evaluateReplannerSkip(input: SkipGroundingInput): SkipGroundingVerdict {
  const missing = missingExpectedFiles(input.expectedFiles, input.fileContents);
  const reason = input.reason.trim();

  if (missing.length > 0 && looksLikeAlreadyDoneSkip(reason)) {
    return {
      allow: false,
      blockReason:
        `skip claims work is already done but expected file(s) missing on disk: ${missing.join(", ")}`,
    };
  }

  if (
    input.unmetCriteriaCount > 0
    && looksLikeOutOfScopeSkip(reason)
    && (hasTestPath(input.expectedFiles) || missing.length > 0)
  ) {
    return {
      allow: false,
      blockReason:
        "skip waives contract work as out-of-scope while criteria remain unmet and expected files/tests are still required",
    };
  }

  if (input.unmetCriteriaCount > 0 && missing.length === input.expectedFiles.length && input.expectedFiles.length > 0) {
    if (!looksLikeAlreadyDoneSkip(reason)) {
      return { allow: true };
    }
    return {
      allow: false,
      blockReason: `all expected files missing (${missing.join(", ")}) — revise todo instead of skip`,
    };
  }

  return { allow: true };
}