/** Shared tool-profile resolution for swarm roles (server + web UI). */

export type AgentToolRole = "planner" | "worker" | "worker-build" | "auditor" | "read";

export interface WebToolsConfig {
  webTools?: boolean;
  plannerTools?: boolean;
}

export type ToolProfileId =
  | "swarm"
  | "swarm-read"
  | "swarm-planner"
  | "swarm-builder"
  | "swarm-builder-research"
  | "swarm-research";

export function isWebToolsEnabled(cfg?: WebToolsConfig | null): boolean {
  return !!(cfg?.webTools || cfg?.plannerTools);
}

export function resolveToolProfileId(
  role: AgentToolRole,
  cfg?: WebToolsConfig | null,
): ToolProfileId {
  const web = isWebToolsEnabled(cfg);
  switch (role) {
    case "planner":
      return web ? "swarm-planner" : "swarm-read";
    case "worker":
      // Hunk workers always get read/grep/glob/list — todos routinely reference
      // files beyond the windowed excerpt and workers must verify anchors.
      return web ? "swarm-research" : "swarm-read";
    case "worker-build":
      return web ? "swarm-builder-research" : "swarm-builder";
    case "auditor":
    case "read":
      return web ? "swarm-research" : "swarm-read";
  }
}

/** Discussion-preset roles map to the same profiles as blackboard read/build. */
export type DiscussionToolRole = "reader" | "builder";

export function resolveDiscussionProfileId(
  role: DiscussionToolRole,
  cfg?: WebToolsConfig | null,
): ToolProfileId {
  return resolveToolProfileId(role === "reader" ? "read" : "worker-build", cfg);
}

const KNOWN_PROFILES: ReadonlySet<string> = new Set([
  "swarm",
  "swarm-read",
  "swarm-planner",
  "swarm-builder",
  "swarm-builder-research",
  "swarm-research",
]);

/**
 * Upgrade legacy profile names when web tools are enabled.
 * Lets discussion runners keep passing "swarm-read" while gaining web_search/web_fetch.
 */
export function effectiveToolProfileId(
  agentName: string,
  cfg?: WebToolsConfig | null,
): ToolProfileId {
  const base = (KNOWN_PROFILES.has(agentName) ? agentName : "swarm") as ToolProfileId;
  if (!isWebToolsEnabled(cfg)) return base;
  if (base === "swarm-read") return "swarm-research";
  if (base === "swarm-builder") return "swarm-builder-research";
  return base;
}

export function allowsUnboundedToolTurns(profile: ToolProfileId): boolean {
  // Workers/auditors with read tools routinely grep across many files per todo.
  return (
    profile === "swarm-read"
    || profile === "swarm-planner"
    || profile === "swarm-research"
    || profile === "swarm-builder-research"
  );
}

export const PROFILE_TOOLS: Record<ToolProfileId, readonly string[]> = {
  swarm: [],
  "swarm-read": ["read", "grep", "glob", "list"],
  "swarm-planner": ["read", "grep", "glob", "list", "web_search", "web_fetch"],
  "swarm-builder": ["read", "grep", "glob", "list", "bash"],
  "swarm-builder-research": ["read", "grep", "glob", "list", "bash", "web_search", "web_fetch"],
  "swarm-research": ["read", "grep", "glob", "list", "web_search", "web_fetch"],
};

export interface ToolingMatrixRow {
  role: string;
  profile: ToolProfileId;
  tools: readonly string[];
}

export function toolingMatrix(cfg?: WebToolsConfig | null): ToolingMatrixRow[] {
  const roles: Array<{ label: string; role: AgentToolRole }> = [
    { label: "Planner", role: "planner" },
    { label: "Worker", role: "worker" },
    { label: "Build worker", role: "worker-build" },
    { label: "Auditor", role: "auditor" },
  ];
  return roles.map(({ label, role }) => {
    const profile = resolveToolProfileId(role, cfg);
    return { role: label, profile, tools: PROFILE_TOOLS[profile] };
  });
}