import { useState, useMemo, useEffect, useCallback } from "react";
import { useSwarm } from "../state/store";
import { PRESETS } from "../components/setup/presets";
import { DEFAULT_ROLES_WEB, type SwarmRoleWeb } from "../components/setup/RoleDiffSettings";
import { type CouncilContractPref } from "../components/setup/BlackboardSettings";
import type { Topology } from "../../../shared/src/topology";
import { detectProvider, type Provider } from "../../../shared/src/providers";
import { useSwarmSettings } from "./useSwarmSettings";
import { loadRecentRuns, type RecentRun } from "../components/setup/RecentRuns";
import { usePreflight } from "./usePreflight";
import { DIRECTIVE_README_AND_RESEARCH } from "../components/setup/presets";

// All the state and core logic extracted from the monolithic SetupForm
// to keep the component file under control (~300-400 lines of JSX + wiring
// instead of 1600+).

// Placeholder hook for future state extraction.
// Currently the state lives in SetupForm to avoid large refactors in one step.
// This file exists as the landing place for the next phase of shrinking SetupForm.
export function useSetupFormState() {
  // Intentionally empty for now. See SetupForm for the live state.
  return {};
}
