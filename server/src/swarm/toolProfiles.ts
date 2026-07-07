import {
  isWebToolsEnabled,
  resolveToolProfileId,
  type AgentToolRole,
  type WebToolsConfig,
} from "../../../shared/src/toolProfiles.js";
import type { ProfileName } from "../tools/ToolDispatcher.js";

export { isWebToolsEnabled, type AgentToolRole, type WebToolsConfig };

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