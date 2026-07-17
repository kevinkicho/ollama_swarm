/** Shared tool-profile resolution for swarm roles (server + web UI). */

export type AgentToolRole = "planner" | "worker" | "worker-build" | "auditor" | "read";

export interface WebToolsConfig {
  webTools?: boolean;
  plannerTools?: boolean;
  /**
   * Auto-approve / high-trust mode: every role gets the max toolkit
   * (bash + web + propose_hunks), auditor gates auto-pass, bash backoff
   * is relaxed. Prefer for trusted local runs only.
   */
  autoApprove?: boolean;
}

export type ToolProfileId =
  | "swarm"
  | "swarm-read"
  | "swarm-planner"
  | "swarm-builder"
  | "swarm-builder-research"
  | "swarm-research"
  | "swarm-auto";

export function isWebToolsEnabled(cfg?: WebToolsConfig | null): boolean {
  return !!(cfg?.webTools || cfg?.plannerTools);
}

export function isAutoApproveEnabled(cfg?: WebToolsConfig | null): boolean {
  return !!cfg?.autoApprove;
}

export function resolveToolProfileId(
  role: AgentToolRole,
  cfg?: WebToolsConfig | null,
): ToolProfileId {
  // Auto-approve: elevates *every* role to the max local toolkit.
  if (isAutoApproveEnabled(cfg)) return "swarm-auto";

  const web = isWebToolsEnabled(cfg);
  switch (role) {
    case "planner":
      // Planner always gets the full read/web/bash toolkit — not gated on run config.
      return "swarm-planner";
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
  "swarm-auto",
]);

/**
 * Upgrade legacy profile names when web tools / autoApprove are enabled.
 * Lets discussion runners keep passing "swarm-read" while gaining web_search/web_fetch.
 */
export function effectiveToolProfileId(
  agentName: string,
  cfg?: WebToolsConfig | null,
): ToolProfileId {
  if (isAutoApproveEnabled(cfg)) return "swarm-auto";
  const base = (KNOWN_PROFILES.has(agentName) ? agentName : "swarm") as ToolProfileId;
  if (!isWebToolsEnabled(cfg)) return base;
  if (base === "swarm-read") return "swarm-research";
  if (base === "swarm-builder") return "swarm-builder-research";
  return base;
}

/** Tools-off profile for structured JSON emit retries (no read/bash loops). */
export const EMIT_ONLY_PROFILE_ID: ToolProfileId = "swarm";

/** Max provider round-trips (model → tool → model) for explore-style profiles. */
export const EXPLORE_MAX_TOOL_TURNS = 20;

/** Council/blackboard workers with web tools — doc updates need more headroom. */
export const EXPLORE_MAX_BUILDER_RESEARCH_TOOL_TURNS = 40;

/** Read-only research profile (hunk workers with web on). */
export const EXPLORE_MAX_RESEARCH_TOOL_TURNS = 35;

/** Dedicated literature pre-pass before hunk emit (web_search heavy). */
export const EXPLORE_MAX_LITERATURE_TOOL_TURNS = 40;

/** Literature pre-pass profile — call sites pass web-only tools (no repo tour). */
export const LITERATURE_RESEARCH_PROFILE: ToolProfileId = "swarm-research";

export const LITERATURE_RESEARCH_TOOLS = ["web_search", "web_fetch"] as const;

export const LITERATURE_RESEARCH_NUDGE_TURN = 25;

export const LITERATURE_RESEARCH_NUDGE_MESSAGE =
  "Stop searching. Emit your research notes now as plain prose with bullet points and URLs. Do not call more tools or emit JSON hunks.";

/** Worker hunk emit — stop repo tour and output JSON. */
export const WORKER_JSON_NUDGE_TURN = 15;

export const WORKER_JSON_NUDGE_MESSAGE =
  "Stop exploring. Emit your JSON hunk array now (or {\"skip\":true} if out of scope). No more tool calls.";

/**
 * Soft nudge only — discussion drafts must NOT hard-cap tools at a low N.
 * Live 37139155: all 3 agents hit "exceeded 10 turns" and posted incomplete drafts.
 * Use profile default tool budget; nudge later so exploration can finish.
 *
 * @deprecated Kept for any remaining import sites; prefer omit maxToolTurns.
 */
export const EXPLORE_MAX_DISCUSSION_DRAFT_TOOL_TURNS = 20;

/** Soft nudge (not a hard stop) for discussion drafters. */
export const DISCUSSION_DRAFT_JSON_NUDGE_TURN = 12;

export const DISCUSSION_DRAFT_JSON_NUDGE_MESSAGE =
  "You have enough exploration. Prefer emitting your council draft soon as clear findings "
  + "(JSON array of issues/actions or structured prose). More tools only if a specific path is still missing.";

/** Hard wall-clock caps for provider prompts (ms). */
export const DEFAULT_WORKER_PROMPT_WALL_CLOCK_MS = 120_000;
/** Create-scaffold worker turns (emit-only + exemplar) — longer for JSON hunks. */
export const DEFAULT_WORKER_CREATE_SCAFFOLD_WALL_CLOCK_MS = 240_000;
export const DEFAULT_PLANNER_PROMPT_WALL_CLOCK_MS = 180_000;
/** Discussion draft / reveal rounds — slightly longer for mixed tool+think. */
export const DEFAULT_DISCUSSION_DRAFT_PROMPT_WALL_CLOCK_MS = 150_000;

export function defaultPromptWallClockMs(profile: string | null | undefined): number | undefined {
  if (!profile) return DEFAULT_WORKER_PROMPT_WALL_CLOCK_MS;
  if (profile === "swarm-planner") return DEFAULT_PLANNER_PROMPT_WALL_CLOCK_MS;
  if (profile.startsWith("swarm")) return DEFAULT_WORKER_PROMPT_WALL_CLOCK_MS;
  return undefined;
}

export function resolveWorkerPromptWallClockMs(opts?: {
  profile?: string | null;
  createScaffold?: boolean;
}): number | undefined {
  if (opts?.createScaffold) return DEFAULT_WORKER_CREATE_SCAFFOLD_WALL_CLOCK_MS;
  return defaultPromptWallClockMs(opts?.profile);
}

export function workerJsonNudgeForProfile(
  profile: string | null | undefined,
): { atTurn: number; message: string } | undefined {
  if (
    profile === "swarm-builder"
    || profile === "swarm-builder-research"
    || profile === "swarm-auto"
  ) {
    return { atTurn: WORKER_JSON_NUDGE_TURN, message: WORKER_JSON_NUDGE_MESSAGE };
  }
  return undefined;
}

/** Discussion-draft emit nudge (independent of worker profile). */
export function discussionDraftJsonNudge(): { atTurn: number; message: string } {
  return {
    atTurn: DISCUSSION_DRAFT_JSON_NUDGE_TURN,
    message: DISCUSSION_DRAFT_JSON_NUDGE_MESSAGE,
  };
}

/**
 * Contract explore (run d3f56d9a): agents grepped until full planner cap (20)
 * and never emitted criteria JSON. Cap + nudge force emit-biased explore.
 */
export const EXPLORE_MAX_CONTRACT_EXPLORE_TOOL_TURNS = 10;

export const CONTRACT_EXPLORE_JSON_NUDGE_TURN = 6;

export const CONTRACT_EXPLORE_JSON_NUDGE_MESSAGE =
  "Stop exploring the repo. Emit the exit contract JSON NOW "
  + "(missionStatement + criteria with expectedFiles). No more tool calls.";

/** Contract merge must not re-open repo tour — JSON synthesis only. */
export const CONTRACT_MERGE_MAX_TOOL_TURNS = 0;

export function contractExploreJsonNudge(): { atTurn: number; message: string } {
  return {
    atTurn: CONTRACT_EXPLORE_JSON_NUDGE_TURN,
    message: CONTRACT_EXPLORE_JSON_NUDGE_MESSAGE,
  };
}

/** Tighter cap for blackboard planning explore turns (todos / research / replan). */
export const EXPLORE_MAX_PLANNING_TOOL_TURNS = 12;

/** Goal-generation pre-pass — seed file list is usually sufficient. */
export const EXPLORE_MAX_GOAL_PREPASS_TOOL_TURNS = 6;

export type PlanningToolPhase =
  | "goal-pre-pass"
  | "contract-explore"
  | "planner-todos-explore"
  | "research-pre-pass"
  | "tier-up"
  | "replan";

export interface PlanningToolCapConfig {
  planningFastPath?: boolean;
}

export function resolveMaxToolTurnsForPlanningPhase(
  phase: PlanningToolPhase,
  cfg?: PlanningToolCapConfig | null,
): number {
  const fast = cfg?.planningFastPath === true;
  switch (phase) {
    case "goal-pre-pass":
      return fast ? 4 : EXPLORE_MAX_GOAL_PREPASS_TOOL_TURNS;
    // d3f56d9a: contract explore needs emit-biased budget (not full planner 12/20)
    case "contract-explore":
      return fast ? 6 : EXPLORE_MAX_CONTRACT_EXPLORE_TOOL_TURNS;
    case "planner-todos-explore":
    case "research-pre-pass":
    case "tier-up":
    case "replan":
      return fast ? 8 : EXPLORE_MAX_PLANNING_TOOL_TURNS;
  }
}
export function allowsUnboundedToolTurns(profile: ToolProfileId): boolean {
  // Legacy name — explore profiles use EXPLORE_MAX_TOOL_TURNS, not infinity.
  return (
    profile === "swarm-read"
    || profile === "swarm-planner"
    || profile === "swarm-research"
    || profile === "swarm-builder-research"
    || profile === "swarm-auto"
  );
}

/** Tool-loop cap for a profile, or undefined to use the provider default (10). */
export function resolveMaxToolTurnsForProfile(profile: ToolProfileId): number | undefined {
  if (!allowsUnboundedToolTurns(profile)) return undefined;
  if (profile === "swarm-auto") return EXPLORE_MAX_BUILDER_RESEARCH_TOOL_TURNS;
  if (profile === "swarm-builder-research") return EXPLORE_MAX_BUILDER_RESEARCH_TOOL_TURNS;
  if (profile === "swarm-research") return EXPLORE_MAX_RESEARCH_TOOL_TURNS;
  return EXPLORE_MAX_TOOL_TURNS;
}

export const PROFILE_TOOLS: Record<ToolProfileId, readonly string[]> = {
  swarm: [],
  "swarm-read": ["read", "grep", "glob", "list"],
  "swarm-planner": ["read", "grep", "glob", "list", "bash", "web_search", "web_fetch"],
  "swarm-builder": ["read", "grep", "glob", "list", "bash", "propose_hunks"],
  "swarm-builder-research": [
    "read",
    "grep",
    "glob",
    "list",
    "bash",
    "web_search",
    "web_fetch",
    "propose_hunks",
  ],
  /** Auto-approve / high-trust: max toolkit for every role. */
  "swarm-auto": [
    "read",
    "grep",
    "glob",
    "list",
    "bash",
    "web_search",
    "web_fetch",
    "propose_hunks",
  ],
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