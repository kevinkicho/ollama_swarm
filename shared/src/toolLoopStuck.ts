export type ToolTurnSnapshot = {
  tool: string;
  ok: boolean;
  argsKey: string;
};

export interface ToolLoopStuckOptions {
  maxConsecutiveErrors?: number;
  maxSameCallRepeats?: number;
  /** Tools treated as research (default web_search / web_fetch). */
  researchTools?: readonly string[];
  /** Consecutive failed research calls (any args) before stuck. */
  maxResearchFailures?: number;
}

const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_MAX_SAME_CALL_REPEATS = 3;
const DEFAULT_MAX_RESEARCH_FAILURES = 3;
const DEFAULT_RESEARCH_TOOLS = ["web_search", "web_fetch"] as const;

function stableArgsKey(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, Object.keys(args).sort());
  } catch {
    return String(args);
  }
}

/**
 * Detect tool loops that burn context without progress.
 *
 * Layers (run 9f449937 literature thrash):
 *  1. N consecutive errors of any tools
 *  2. N identical (tool, args) repeats
 *  3. N consecutive research-tool failures (any args) — search 403 storms
 */
export function createToolLoopStuckDetector(opts: ToolLoopStuckOptions = {}) {
  const maxErrors = opts.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const maxRepeats = opts.maxSameCallRepeats ?? DEFAULT_MAX_SAME_CALL_REPEATS;
  const researchTools = new Set(
    (opts.researchTools ?? DEFAULT_RESEARCH_TOOLS).map((t) => t.toLowerCase()),
  );
  const maxResearchFailures = opts.maxResearchFailures ?? DEFAULT_MAX_RESEARCH_FAILURES;
  const history: ToolTurnSnapshot[] = [];
  let researchFailStreak = 0;

  return {
    record(tool: string, ok: boolean, args: Record<string, unknown>): string | null {
      history.push({ tool, ok, argsKey: stableArgsKey(args) });

      const isResearch = researchTools.has(tool.toLowerCase());
      if (isResearch) {
        researchFailStreak = ok ? 0 : researchFailStreak + 1;
      }

      const errTail = history.slice(-maxErrors);
      if (errTail.length >= maxErrors && errTail.every((t) => !t.ok)) {
        return `tool loop stuck: ${maxErrors} consecutive tool errors`;
      }

      const repTail = history.slice(-maxRepeats);
      if (
        repTail.length >= maxRepeats
        && repTail.every((t) => t.tool === repTail[0]!.tool && t.argsKey === repTail[0]!.argsKey)
      ) {
        return `tool loop stuck: ${maxRepeats}× repeated ${repTail[0]!.tool} with identical args`;
      }

      if (isResearch && researchFailStreak >= maxResearchFailures) {
        return (
          `tool loop stuck: ${maxResearchFailures} consecutive research tool failures ` +
          `(web_search/web_fetch) — switch to local read/grep or a known official URL`
        );
      }

      return null;
    },
    history(): readonly ToolTurnSnapshot[] {
      return history;
    },
  };
}
