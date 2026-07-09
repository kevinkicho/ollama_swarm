// Mid-run limit adjustments (extend-only). Mutates the live RunConfig in place
// so runners that re-read cfg each tick pick up new caps without restart.

import type { RunConfig } from "./SwarmRunner.js";
import {
  applyThinkGuardRefereePatch,
  formatThinkGuardRefereeChanges,
  patchHasThinkGuardReferee,
  type ThinkGuardRefereeReconfigChanges,
} from "@ollama-swarm/shared/thinkGuardBudget";

export const RECONFIG_MAX_ROUNDS = 100;
export const RECONFIG_MAX_WALL_CLOCK_MS = 24 * 60 * 60_000;
export const RECONFIG_MAX_TOKEN_BUDGET = 50_000_000;

export interface RunReconfigPatch {
  /** Absolute new round limit (must exceed current when rounds > 0). */
  rounds?: number;
  wallClockCapMs?: number;
  /** Convenience alias for wallClockCapMs (minutes). */
  wallClockCapMin?: number;
  tokenBudget?: number;
  /** Add N rounds to the current limit. */
  extendRounds?: number;
  /** Add N minutes to the wall-clock cap (or set relative cap when none). */
  extendWallClockCapMin?: number;
  /** Add N tokens to the current budget (or set when none). */
  extendTokenBudget?: number;
  thinkGuardRefereeEnabled?: boolean;
  thinkGuardRefereeMaxCallsPerRun?: number;
  thinkGuardRefereeMinThinkChars?: number;
  thinkGuardRefereeThinkTailMinChars?: number;
  thinkGuardRefereeThinkTailMaxChars?: number;
  thinkGuardRefereeMaxOutputTokens?: number;
}

export interface RunReconfigFieldChange<T = number> {
  from: T | undefined;
  to: T;
}

export interface RunReconfigChanges {
  rounds?: RunReconfigFieldChange;
  wallClockCapMs?: RunReconfigFieldChange;
  tokenBudget?: RunReconfigFieldChange;
  thinkGuardReferee?: ThinkGuardRefereeReconfigChanges;
}

export type RunReconfigResult =
  | { ok: true; changes: RunReconfigChanges; message: string }
  | { ok: false; error: string };

export interface ApplyRunReconfigOpts {
  /** Run start time — needed to set a new wall-clock cap when none exists. */
  startedAt?: number;
  now?: number;
}

function patchHasLimits(patch: RunReconfigPatch): boolean {
  return (
    patch.rounds != null
    || patch.wallClockCapMs != null
    || patch.wallClockCapMin != null
    || patch.tokenBudget != null
    || patch.extendRounds != null
    || patch.extendWallClockCapMin != null
    || patch.extendTokenBudget != null
    || patchHasThinkGuardReferee(patch)
  );
}

function resolveWallClockTargetMs(
  cfg: RunConfig,
  patch: RunReconfigPatch,
  opts: ApplyRunReconfigOpts,
): { ok: true; ms: number } | { ok: false; error: string } {
  const now = opts.now ?? Date.now();
  const elapsed = opts.startedAt != null ? Math.max(0, now - opts.startedAt) : 0;
  const current = cfg.wallClockCapMs;

  if (patch.extendWallClockCapMin != null) {
    const addMs = patch.extendWallClockCapMin * 60_000;
    if (addMs <= 0) return { ok: false, error: "extendWallClockCapMin must be positive" };
    const base = current != null && current > 0 ? current : elapsed + 60_000;
    return { ok: true, ms: base + addMs };
  }

  let target = patch.wallClockCapMs;
  if (patch.wallClockCapMin != null) {
    target = patch.wallClockCapMin * 60_000;
  }
  if (target == null) return { ok: false, error: "no wall-clock target" };
  if (target <= 0) return { ok: false, error: "wall-clock cap must be positive" };
  if (target > RECONFIG_MAX_WALL_CLOCK_MS) {
    return { ok: false, error: `wall-clock cap exceeds max (${RECONFIG_MAX_WALL_CLOCK_MS / 60_000} min)` };
  }
  const floor = current != null && current > 0 ? current : elapsed + 60_000;
  if (target <= floor) {
    return {
      ok: false,
      error: current != null && current > 0
        ? `wall-clock cap must exceed current (${Math.round(current / 60_000)} min)`
        : `wall-clock cap must exceed elapsed runtime (${Math.round(elapsed / 60_000)} min)`,
    };
  }
  return { ok: true, ms: target };
}

function resolveRoundsTarget(cfg: RunConfig, patch: RunReconfigPatch): { ok: true; n: number } | { ok: false; error: string } {
  const current = cfg.rounds ?? 0;
  if (patch.extendRounds != null) {
    if (patch.extendRounds <= 0) return { ok: false, error: "extendRounds must be positive" };
    if (current === 0) {
      return {
        ok: false,
        error: "cannot extend rounds on a continuous run (rounds=0) — set an absolute rounds value instead",
      };
    }
    return { ok: true, n: current + patch.extendRounds };
  }
  if (patch.rounds == null) return { ok: false, error: "no rounds target" };
  if (!Number.isInteger(patch.rounds) || patch.rounds <= 0) {
    return { ok: false, error: "rounds must be a positive integer" };
  }
  if (patch.rounds > RECONFIG_MAX_ROUNDS) {
    return { ok: false, error: `rounds exceeds max (${RECONFIG_MAX_ROUNDS})` };
  }
  if (current > 0 && patch.rounds <= current) {
    return { ok: false, error: `rounds must exceed current limit (${current})` };
  }
  if (current === 0 && patch.rounds <= 0) {
    return { ok: false, error: "rounds must be positive" };
  }
  return { ok: true, n: patch.rounds };
}

function resolveTokenTarget(cfg: RunConfig, patch: RunReconfigPatch): { ok: true; n: number } | { ok: false; error: string } {
  const current = cfg.tokenBudget;
  if (patch.extendTokenBudget != null) {
    if (patch.extendTokenBudget <= 0) return { ok: false, error: "extendTokenBudget must be positive" };
    const base = current != null && current > 0 ? current : 0;
    return { ok: true, n: base + patch.extendTokenBudget };
  }
  if (patch.tokenBudget == null) return { ok: false, error: "no token budget target" };
  if (!Number.isInteger(patch.tokenBudget) || patch.tokenBudget <= 0) {
    return { ok: false, error: "tokenBudget must be a positive integer" };
  }
  if (patch.tokenBudget > RECONFIG_MAX_TOKEN_BUDGET) {
    return { ok: false, error: `tokenBudget exceeds max (${RECONFIG_MAX_TOKEN_BUDGET.toLocaleString()})` };
  }
  if (current != null && current > 0 && patch.tokenBudget <= current) {
    return { ok: false, error: `tokenBudget must exceed current (${current.toLocaleString()})` };
  }
  return { ok: true, n: patch.tokenBudget };
}

export function formatReconfigMessage(changes: RunReconfigChanges): string {
  const parts: string[] = [];
  if (changes.rounds) {
    parts.push(`rounds ${changes.rounds.from ?? "?"} → ${changes.rounds.to}`);
  }
  if (changes.wallClockCapMs) {
    const fromMin = changes.wallClockCapMs.from != null
      ? `${Math.round(changes.wallClockCapMs.from / 60_000)}m`
      : "none";
    parts.push(`wall-clock cap ${fromMin} → ${Math.round(changes.wallClockCapMs.to / 60_000)}m`);
  }
  if (changes.tokenBudget) {
    const fromTok = changes.tokenBudget.from != null
      ? changes.tokenBudget.from.toLocaleString()
      : "none";
    parts.push(`token budget ${fromTok} → ${changes.tokenBudget.to.toLocaleString()}`);
  }
  if (changes.thinkGuardReferee) {
    parts.push(...formatThinkGuardRefereeChanges(changes.thinkGuardReferee));
  }
  return `[reconfig] Run limits updated: ${parts.join("; ")}.`;
}

/** Apply extend-only limit changes to cfg (mutates in place). */
export function applyRunReconfig(
  cfg: RunConfig,
  patch: RunReconfigPatch,
  opts: ApplyRunReconfigOpts = {},
): RunReconfigResult {
  if (!patchHasLimits(patch)) {
    return { ok: false, error: "at least one limit field is required" };
  }

  const changes: RunReconfigChanges = {};
  const conflicts: string[] = [];
  if (patch.rounds != null && patch.extendRounds != null) conflicts.push("rounds");
  if ((patch.wallClockCapMs != null || patch.wallClockCapMin != null) && patch.extendWallClockCapMin != null) {
    conflicts.push("wallClockCap");
  }
  if (patch.tokenBudget != null && patch.extendTokenBudget != null) conflicts.push("tokenBudget");
  if (conflicts.length > 0) {
    return { ok: false, error: `conflicting absolute and extend fields: ${conflicts.join(", ")}` };
  }

  if (patch.rounds != null || patch.extendRounds != null) {
    const resolved = resolveRoundsTarget(cfg, patch);
    if (!resolved.ok) return resolved;
    changes.rounds = { from: cfg.rounds, to: resolved.n };
    cfg.rounds = resolved.n;
  }

  if (patch.wallClockCapMs != null || patch.wallClockCapMin != null || patch.extendWallClockCapMin != null) {
    const resolved = resolveWallClockTargetMs(cfg, patch, opts);
    if (!resolved.ok) return resolved;
    changes.wallClockCapMs = { from: cfg.wallClockCapMs, to: resolved.ms };
    cfg.wallClockCapMs = resolved.ms;
  }

  if (patch.tokenBudget != null || patch.extendTokenBudget != null) {
    const resolved = resolveTokenTarget(cfg, patch);
    if (!resolved.ok) return resolved;
    changes.tokenBudget = { from: cfg.tokenBudget, to: resolved.n };
    cfg.tokenBudget = resolved.n;
  }

  if (patchHasThinkGuardReferee(patch)) {
    const tg = applyThinkGuardRefereePatch(cfg, patch);
    if (!tg.ok) return tg;
    if (Object.keys(tg.changes).length > 0) {
      changes.thinkGuardReferee = tg.changes;
    }
  }

  return { ok: true, changes, message: formatReconfigMessage(changes) };
}