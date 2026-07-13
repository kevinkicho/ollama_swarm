/**
 * Brain RECONFIG saved after a finished run (sessionStorage) so the next
 * start can pick up extended wall-clock / rounds / token budget.
 */

import type { RunReconfigPatch } from "../components/brainChat/types";

export const DEFERRED_RECONFIG_KEY = "swarm:deferredReconfig";
/** Ignore deferred patches older than this (ms). */
export const DEFERRED_RECONFIG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type DeferredReconfigRecord = {
  runId?: string;
  patch: RunReconfigPatch;
  at: number;
};

export function readDeferredReconfig(
  now = Date.now(),
): DeferredReconfigRecord | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(DEFERRED_RECONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeferredReconfigRecord;
    if (!parsed?.patch || typeof parsed.at !== "number") return null;
    if (now - parsed.at > DEFERRED_RECONFIG_MAX_AGE_MS) {
      sessionStorage.removeItem(DEFERRED_RECONFIG_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearDeferredReconfig(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(DEFERRED_RECONFIG_KEY);
  } catch {
    /* ignore */
  }
}

export function writeDeferredReconfig(
  record: DeferredReconfigRecord,
): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(DEFERRED_RECONFIG_KEY, JSON.stringify(record));
  } catch {
    /* ignore */
  }
}

/**
 * Merge a RECONFIG patch into start-form / start-payload fields.
 * Absolute targets win over extend-*; returns only fields that changed.
 */
export function applyDeferredReconfigToStartFields(input: {
  rounds: number;
  wallClockCapMin: string;
  tokenBudget?: number;
  patch: RunReconfigPatch;
}): {
  rounds: number;
  wallClockCapMin: string;
  tokenBudget?: number;
  applied: string[];
} {
  const patch = input.patch;
  const applied: string[] = [];
  let rounds = input.rounds;
  let wallClockCapMin = input.wallClockCapMin;
  let tokenBudget = input.tokenBudget;

  if (typeof patch.rounds === "number" && Number.isFinite(patch.rounds)) {
    rounds = Math.max(0, Math.floor(patch.rounds));
    applied.push(`rounds→${rounds}`);
  } else if (
    typeof patch.extendRounds === "number"
    && Number.isFinite(patch.extendRounds)
    && patch.extendRounds > 0
  ) {
    // Autonomous (0) stays open-ended; finite rounds get an extension.
    if (rounds > 0) {
      rounds = rounds + Math.floor(patch.extendRounds);
      applied.push(`rounds+${Math.floor(patch.extendRounds)}→${rounds}`);
    }
  }

  if (
    typeof patch.wallClockCapMin === "number"
    && Number.isFinite(patch.wallClockCapMin)
    && patch.wallClockCapMin > 0
  ) {
    wallClockCapMin = String(Math.floor(patch.wallClockCapMin));
    applied.push(`cap→${wallClockCapMin}m`);
  } else if (
    typeof patch.wallClockCapMs === "number"
    && Number.isFinite(patch.wallClockCapMs)
    && patch.wallClockCapMs > 0
  ) {
    wallClockCapMin = String(Math.max(1, Math.round(patch.wallClockCapMs / 60_000)));
    applied.push(`cap→${wallClockCapMin}m`);
  } else if (
    typeof patch.extendWallClockCapMin === "number"
    && Number.isFinite(patch.extendWallClockCapMin)
    && patch.extendWallClockCapMin > 0
  ) {
    const cur = Number(wallClockCapMin);
    const base = Number.isFinite(cur) && cur > 0 ? cur : 0;
    const next = base + Math.floor(patch.extendWallClockCapMin);
    wallClockCapMin = String(next);
    applied.push(`cap+${Math.floor(patch.extendWallClockCapMin)}m→${next}m`);
  }

  if (
    typeof patch.tokenBudget === "number"
    && Number.isFinite(patch.tokenBudget)
    && patch.tokenBudget > 0
  ) {
    tokenBudget = Math.floor(patch.tokenBudget);
    applied.push(`tokens→${tokenBudget}`);
  } else if (
    typeof patch.extendTokenBudget === "number"
    && Number.isFinite(patch.extendTokenBudget)
    && patch.extendTokenBudget > 0
  ) {
    const base = tokenBudget && tokenBudget > 0 ? tokenBudget : 0;
    tokenBudget = base + Math.floor(patch.extendTokenBudget);
    applied.push(`tokens+${Math.floor(patch.extendTokenBudget)}→${tokenBudget}`);
  }

  return { rounds, wallClockCapMin, tokenBudget, applied };
}
