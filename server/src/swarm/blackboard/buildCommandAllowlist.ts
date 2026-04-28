// Task #237 (2026-04-28): defense-in-depth allowlist for build-style
// TODOs that run shell commands via the swarm-builder agent.
//
// The swarm-builder agent has opencode's bash tool enabled. opencode's
// bash sandbox is one layer of safety. This allowlist is a SECOND
// layer enforced server-side BEFORE we even dispatch to the agent.
//
// Allow rule: the command's first whitespace-separated token (the
// binary name) must be in the allowlist. Anything not matching is
// rejected with a clear error before any model call happens.
//
// Why a binary-only allowlist (not full command parsing): we want to
// permit `npm run docs:api`, `bun run test`, `pnpm install --frozen-
// lockfile`, etc. — without trying to parse + validate every
// argument. The allowed binaries are constrained to project tooling
// that operates within the clone's working tree. We DON'T allow
// generic shell utilities (curl, wget, sh, bash, eval, exec) that
// could egress the sandbox or pipe arbitrary code.

const ALLOWED_BINARIES = new Set([
  // Package managers — most build-style TODOs route through these
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "bunx",
  // Compilers / type-checkers
  "tsc",
  "tsx",
  "deno",
  // Linters / formatters
  "eslint",
  "prettier",
  "biome",
  // Test runners (some standalone)
  "jest",
  "vitest",
  "mocha",
  // Common build wrappers
  "make",
  "task",
  "just",
  // Doc generators (the use case that surfaced this need —
  // run b2ee7f04 skipped a `bun run docs:api` TODO)
  "typedoc",
  "jsdoc",
  "docusaurus",
] as const);

export interface AllowlistResult {
  ok: boolean;
  /** When ok=false, the human-readable refusal reason. */
  reason?: string;
  /** When ok=true, the parsed binary name (first token). */
  binary?: string;
}

/**
 * Check whether a command string is allowed for build-style TODO
 * execution. Returns the binary name on success, a refusal reason
 * on failure.
 *
 * Rules (in evaluation order):
 *  - Reject empty / whitespace-only commands
 *  - Reject any command containing shell metacharacters used to chain
 *    commands or redirect: `;`, `&&`, `||`, `|`, `>`, `<`, backtick,
 *    `$()`. (Even within an allowed binary, command chaining could
 *    smuggle in disallowed binaries.)
 *  - Reject if the first token isn't in ALLOWED_BINARIES
 */
export function checkBuildCommand(rawCommand: string): AllowlistResult {
  const cmd = rawCommand.trim();
  if (cmd.length === 0) {
    return { ok: false, reason: "empty command" };
  }
  // Block shell metacharacters that compose / chain / pipe / redirect.
  // We accept simple `binary arg1 arg2` invocations only.
  const FORBIDDEN_RE = /[;&|<>`$]/;
  const m = FORBIDDEN_RE.exec(cmd);
  if (m) {
    return {
      ok: false,
      reason: `command contains forbidden shell metacharacter \`${m[0]}\` at offset ${m.index}; chaining/piping/redirection is not allowed`,
    };
  }
  // First whitespace-separated token = binary name.
  const binary = cmd.split(/\s+/)[0]!.toLowerCase();
  if (!ALLOWED_BINARIES.has(binary as (typeof ALLOWED_BINARIES extends Set<infer T> ? T : never))) {
    return {
      ok: false,
      reason: `binary \`${binary}\` is not in the build-command allowlist; see server/src/swarm/blackboard/buildCommandAllowlist.ts for the allowed set`,
    };
  }
  return { ok: true, binary };
}

/** Snapshot of the allowlist for documentation / introspection. */
export function listAllowedBinaries(): readonly string[] {
  return [...ALLOWED_BINARIES].sort();
}
