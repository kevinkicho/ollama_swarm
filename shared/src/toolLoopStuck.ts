export type ToolTurnSnapshot = {
  tool: string;
  ok: boolean;
  argsKey: string;
};

export interface ToolLoopStuckOptions {
  maxConsecutiveErrors?: number;
  maxSameCallRepeats?: number;
}

const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_MAX_SAME_CALL_REPEATS = 3;

function stableArgsKey(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, Object.keys(args).sort());
  } catch {
    return String(args);
  }
}

/** Detect tool loops that burn context without progress. */
export function createToolLoopStuckDetector(opts: ToolLoopStuckOptions = {}) {
  const maxErrors = opts.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const maxRepeats = opts.maxSameCallRepeats ?? DEFAULT_MAX_SAME_CALL_REPEATS;
  const history: ToolTurnSnapshot[] = [];

  return {
    record(tool: string, ok: boolean, args: Record<string, unknown>): string | null {
      history.push({ tool, ok, argsKey: stableArgsKey(args) });

      const errTail = history.slice(-maxErrors);
      if (errTail.length >= maxErrors && errTail.every((t) => !t.ok)) {
        return `tool loop stuck: ${maxErrors} consecutive tool errors`;
      }

      const repTail = history.slice(-maxRepeats);
      if (
        repTail.length >= maxRepeats
        && repTail.every((t) => t.tool === repTail[0].tool && t.argsKey === repTail[0].argsKey)
      ) {
        return `tool loop stuck: ${maxRepeats}× repeated ${repTail[0].tool} with identical args`;
      }

      return null;
    },
  };
}