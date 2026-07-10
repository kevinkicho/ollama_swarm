// Build / bash command policy.
//
// 2026-07-10: agents may use full shell composition (`&&`, pipes, etc.) for
// research and build todos. Commands still run with cwd = clone path (see
// ToolDispatcher.bashTool). Empty commands are the only hard reject.

export interface AllowlistResult {
  ok: boolean;
  /** When ok=false, the human-readable refusal reason. */
  reason?: string;
  /** When ok=true, the parsed first token (best-effort). */
  binary?: string;
}

/**
 * Validate a command string before execution.
 * Accepts any non-empty command (including shell metacharacters).
 */
export function checkBuildCommand(rawCommand: string): AllowlistResult {
  const cmd = rawCommand.trim();
  if (cmd.length === 0) {
    return { ok: false, reason: "empty command" };
  }
  // First token is informational only (may be `cd` before `&&` …).
  const binary = cmd.split(/\s+/)[0]!.toLowerCase();
  return { ok: true, binary };
}

/** Historical list kept for docs/introspection; no longer enforced. */
const LEGACY_ALLOWED_BINARIES = [
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "bunx",
  "tsc",
  "tsx",
  "deno",
  "eslint",
  "prettier",
  "biome",
  "jest",
  "vitest",
  "mocha",
  "make",
  "task",
  "just",
  "typedoc",
  "jsdoc",
  "docusaurus",
  "python",
  "python3",
  "pytest",
] as const;

/** Snapshot of the legacy allowlist for documentation / introspection. */
export function listAllowedBinaries(): readonly string[] {
  return [...LEGACY_ALLOWED_BINARIES].sort();
}
