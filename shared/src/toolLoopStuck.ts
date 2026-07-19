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
  /**
   * Builder / mutate tools (write, edit, bash, …). These get softer
   * identical-args and consecutive-error thresholds so iterative builds
   * (re-run tests, refine same file) are not killed at the research default.
   */
  builderTools?: readonly string[];
  maxBuilderSameCallRepeats?: number;
  maxBuilderConsecutiveErrors?: number;
}

const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_MAX_SAME_CALL_REPEATS = 3;
const DEFAULT_MAX_RESEARCH_FAILURES = 3;
const DEFAULT_RESEARCH_TOOLS = ["web_search", "web_fetch"] as const;
/** Softer defaults for real disk/build work. */
const DEFAULT_BUILDER_TOOLS = [
  "write",
  "edit",
  "bash",
  "run",
  "propose_hunks",
  "git_status",
  "git_diff",
] as const;
const DEFAULT_MAX_BUILDER_SAME_CALL_REPEATS = 8;
const DEFAULT_MAX_BUILDER_CONSECUTIVE_ERRORS = 10;

function stableArgsKey(args: Record<string, unknown>): string {
  try {
    // write/edit content can be huge and change each turn — key path only
    // so identical-args detection still catches "write same path+same body" thrash
    // while allowing refine-same-path iteration when content differs.
    const toolHint = typeof args.path === "string" || typeof args.file === "string";
    if (toolHint && (typeof args.content === "string" || typeof args.new_string === "string" || typeof args.old_string === "string")) {
      const slim: Record<string, unknown> = {
        path: args.path ?? args.file,
      };
      // Include a short content fingerprint so identical rewrites still trip.
      const body = String(args.content ?? args.new_string ?? "");
      slim.bodyFp = `${body.length}:${body.slice(0, 64)}:${body.slice(-32)}`;
      if (typeof args.old_string === "string") {
        slim.oldFp = `${args.old_string.length}:${args.old_string.slice(0, 48)}`;
      }
      return JSON.stringify(slim);
    }
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
 *
 * Builder tools (write/edit/bash) use higher N so iterative build loops survive.
 */
export function createToolLoopStuckDetector(opts: ToolLoopStuckOptions = {}) {
  const maxErrors = opts.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const maxRepeats = opts.maxSameCallRepeats ?? DEFAULT_MAX_SAME_CALL_REPEATS;
  const researchTools = new Set(
    (opts.researchTools ?? DEFAULT_RESEARCH_TOOLS).map((t) => t.toLowerCase()),
  );
  const builderTools = new Set(
    (opts.builderTools ?? DEFAULT_BUILDER_TOOLS).map((t) => t.toLowerCase()),
  );
  // Explicit maxSameCallRepeats / maxConsecutiveErrors apply to everyone
  // (tests + strict call sites). Soft builder runway only when using defaults.
  const maxBuilderRepeats =
    opts.maxBuilderSameCallRepeats
    ?? (opts.maxSameCallRepeats !== undefined
      ? opts.maxSameCallRepeats
      : DEFAULT_MAX_BUILDER_SAME_CALL_REPEATS);
  const maxBuilderErrors =
    opts.maxBuilderConsecutiveErrors
    ?? (opts.maxConsecutiveErrors !== undefined
      ? opts.maxConsecutiveErrors
      : DEFAULT_MAX_BUILDER_CONSECUTIVE_ERRORS);
  const maxResearchFailures = opts.maxResearchFailures ?? DEFAULT_MAX_RESEARCH_FAILURES;
  const history: ToolTurnSnapshot[] = [];
  let researchFailStreak = 0;

  return {
    record(tool: string, ok: boolean, args: Record<string, unknown>): string | null {
      const toolLc = tool.toLowerCase();
      history.push({ tool, ok, argsKey: stableArgsKey(args) });

      const isResearch = researchTools.has(toolLc);
      const isBuilder = builderTools.has(toolLc);
      if (isResearch) {
        researchFailStreak = ok ? 0 : researchFailStreak + 1;
      }

      // Consecutive errors: builder-only streaks get a longer runway.
      const errLimit = isBuilder ? maxBuilderErrors : maxErrors;
      const errTail = history.slice(-errLimit);
      if (errTail.length >= errLimit && errTail.every((t) => !t.ok)) {
        return `tool loop stuck: ${errLimit} consecutive tool errors`;
      }
      // Non-builder thrash still trips at the default even mid-builder run.
      if (isBuilder && maxBuilderErrors > maxErrors) {
        const defaultTail = history.slice(-maxErrors);
        if (
          defaultTail.length >= maxErrors
          && defaultTail.every((t) => !t.ok)
          && defaultTail.every((t) => !builderTools.has(t.tool.toLowerCase()))
        ) {
          return `tool loop stuck: ${maxErrors} consecutive tool errors`;
        }
      }

      const repLimit = isBuilder ? maxBuilderRepeats : maxRepeats;
      const repTail = history.slice(-repLimit);
      if (
        repTail.length >= repLimit
        && repTail.every((t) => t.tool === repTail[0]!.tool && t.argsKey === repTail[0]!.argsKey)
      ) {
        return `tool loop stuck: ${repLimit}× repeated ${repTail[0]!.tool} with identical args`;
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
