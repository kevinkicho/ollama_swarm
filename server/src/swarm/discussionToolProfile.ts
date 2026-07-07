import type { ProfileName } from "../tools/ToolDispatcher.js";
import { resolveToolProfile } from "./toolProfiles.js";

/** Reader profile for discussion presets (council, map-reduce, etc.). */
export function discussionReaderProfile(cfg?: unknown): ProfileName {
  return resolveToolProfile("read", cfg);
}

/** Builder profile for discussion presets that run shell-capable agents. */
export function discussionBuilderProfile(cfg?: unknown): ProfileName {
  return resolveToolProfile("worker-build", cfg);
}