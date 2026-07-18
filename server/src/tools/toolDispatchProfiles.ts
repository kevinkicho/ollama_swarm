/**
 * Tool profiles, permissions, and argv tokenization.
 * Extracted from ToolDispatcher for LOC hygiene.
 */

/** Split allowlisted command into argv without a shell. */
export function tokenizeAllowlistedCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export type ToolName = "read" | "grep" | "glob" | "list" | "bash" | "write" | "edit" | "propose_hunks" | "web_fetch" | "web_search";
export type ProfileName =
  | "swarm"
  | "swarm-read"
  | "swarm-planner"
  | "swarm-builder"
  | "swarm-builder-research"
  | "swarm-auto"
  | "swarm-write"
  | "swarm-research";
export type Permission = "allow" | "deny";

export function unrestrictedReadTools(profile: ProfileName): boolean {
  return (
    profile === "swarm-planner"
    || profile === "swarm-research"
    || profile === "swarm-auto"
  );
}

// Default tools list to advertise to the model per profile. Mirrors
// what opencode's permission system grants today. Used by chatOnce /
// promptWithRetry callers to derive `tools` for SessionProvider.chat
// without each caller having to spell out the per-profile list.
export function defaultToolsForProfile(
  profile: ProfileName,
): ReadonlyArray<"read" | "grep" | "glob" | "list" | "bash" | "propose_hunks" | "web_fetch" | "web_search"> {
  switch (profile) {
    case "swarm":
      return [];
    case "swarm-read":
      return ["read", "grep", "glob", "list"];
    case "swarm-planner":
      return ["read", "grep", "glob", "list", "bash", "web_fetch", "web_search"];
    case "swarm-builder":
      return ["read", "grep", "glob", "list", "bash", "propose_hunks"];
    case "swarm-builder-research":
      return ["read", "grep", "glob", "list", "bash", "web_fetch", "web_search", "propose_hunks"];
    case "swarm-auto":
      return ["read", "grep", "glob", "list", "bash", "web_fetch", "web_search", "propose_hunks"];
    case "swarm-write":
      return ["read", "grep", "glob", "list", "propose_hunks"];
    case "swarm-research":
      return ["read", "grep", "glob", "list", "web_fetch", "web_search"];
  }
}

export const PROFILES: Record<ProfileName, Record<ToolName, Permission>> = {
  swarm: {
    read: "deny",
    grep: "deny",
    glob: "deny",
    list: "deny",
    bash: "deny",
    write: "deny",
    edit: "deny",
    propose_hunks: "deny",
    web_fetch: "deny",
    web_search: "deny",
  },
  "swarm-read": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "deny",
    write: "deny",
    edit: "deny",
    propose_hunks: "deny",
    web_fetch: "deny",
    web_search: "deny",
  },
  // Blackboard planners may inspect as many repository files as needed.
  // The profile remains strictly read-only and clone-scoped; its larger
  // provider tool-turn allowance is wired by promptWithRetry.
  "swarm-planner": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "allow",
    write: "deny",
    edit: "deny",
    propose_hunks: "deny",
    web_fetch: "allow",
    web_search: "allow",
  },
  "swarm-builder": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "allow",
    write: "deny",
    edit: "deny",
    propose_hunks: "allow",
    web_fetch: "deny",
    web_search: "deny",
  },
  "swarm-builder-research": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "allow",
    write: "deny",
    edit: "deny",
    propose_hunks: "allow",
    web_fetch: "allow",
    web_search: "allow",
  },
  /** High-trust auto-approve: max toolkit (mutations via propose_hunks apply). */
  "swarm-auto": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "allow",
    write: "deny",
    edit: "deny",
    propose_hunks: "allow",
    web_fetch: "allow",
    web_search: "allow",
  },
  "swarm-write": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "deny",
    write: "deny",
    edit: "deny",
    propose_hunks: "allow",
    web_fetch: "deny",
    web_search: "deny",
  },
  // New profile for external data access (MCP-style). Opt-in via run config.
  "swarm-research": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "deny",
    write: "deny",
    edit: "deny",
    propose_hunks: "deny",
    web_fetch: "allow",
    web_search: "allow",
  },
};

