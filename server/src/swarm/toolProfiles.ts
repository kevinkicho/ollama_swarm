import {
  isWebToolsEnabled,
  PROFILE_TOOLS,
  resolveToolProfileId,
  type AgentToolRole,
  type ToolProfileId,
  type WebToolsConfig,
} from "../../../shared/src/toolProfiles.js";
import type { ProfileName } from "../tools/ToolDispatcher.js";

export { isWebToolsEnabled, PROFILE_TOOLS, type AgentToolRole, type WebToolsConfig };

/** Tools available for a dispatcher profile name (falls back to []). */
export function profileTools(profile: ProfileName): readonly string[] {
  return PROFILE_TOOLS[profile as ToolProfileId] ?? [];
}

function toolConfigFromRun(cfg: unknown): WebToolsConfig | undefined {
  if (!cfg || typeof cfg !== "object") return undefined;
  const o = cfg as Record<string, unknown>;
  return {
    webTools: o.webTools as boolean | undefined,
    plannerTools: o.plannerTools as boolean | undefined,
  };
}

export function resolveToolProfile(role: AgentToolRole, cfg?: unknown): ProfileName {
  return resolveToolProfileId(role, toolConfigFromRun(cfg)) as ProfileName;
}

/** Full toolkit (read/grep/glob/list/bash[/web]) for council agents. */
export function resolveCouncilToolProfile(cfg?: unknown): ProfileName {
  return resolveToolProfile("planner", cfg);
}