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
      return web ? "swarm-research" : "swarm";
    case "worker-build":
      return web ? "swarm-builder-research" : "swarm-builder";
    case "auditor":
    case "read":
      return web ? "swarm-research" : "swarm-read";
  }
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