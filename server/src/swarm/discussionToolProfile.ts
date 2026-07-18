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

/**
 * Profile for discussion turns that may emit file changes.
 * writeMode multi/single → builder (write/edit/git); else reader.
 */
export function discussionProposalProfile(cfg?: {
  writeMode?: "none" | "single" | "multi";
} | null): ProfileName {
  const mode = cfg?.writeMode;
  if (mode === "multi" || mode === "single") {
    return discussionBuilderProfile(cfg);
  }
  return discussionReaderProfile(cfg);
}