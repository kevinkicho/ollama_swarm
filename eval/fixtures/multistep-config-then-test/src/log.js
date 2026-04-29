// formatLog(level, msg, opts) renders a log line. Today opts has only
// {prefix}. The eval task adds a `verbose` option that, when true,
// includes a [v] marker after the level. Then the swarm writes a test
// that exercises both verbose=false (existing behavior) and verbose=true.

export function formatLog(level, msg, opts = {}) {
  const prefix = opts.prefix ?? "";
  return `${prefix}${level.toUpperCase()}: ${msg}`;
}
