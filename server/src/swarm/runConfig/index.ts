// Composed RunConfig from partial interfaces (mechanical extract from runConfigTypes.ts).
import type { RunConfigCore } from "./core.js";
import type { RunConfigModels } from "./models.js";
import type { RunConfigCaps } from "./caps.js";
import type { RunConfigThinkGuard } from "./thinkGuard.js";
import type { RunConfigBlackboard } from "./blackboard.js";
import type { RunConfigDiscussion } from "./discussion.js";

export type { RunConfigCore } from "./core.js";
export type { RunConfigModels } from "./models.js";
export type { RunConfigCaps } from "./caps.js";
export type { RunConfigThinkGuard } from "./thinkGuard.js";
export type { RunConfigBlackboard } from "./blackboard.js";
export type { RunConfigDiscussion } from "./discussion.js";

/** Full per-run config — intersection of focused partial interfaces. */
export type RunConfig = RunConfigCore &
  RunConfigModels &
  RunConfigCaps &
  RunConfigThinkGuard &
  RunConfigBlackboard &
  RunConfigDiscussion;
