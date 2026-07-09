/** Think-stream referee budget defaults and validation (shared server + web). */

export const THINK_GUARD_REFEREE_LIMITS = {
  maxCallsPerRun: { min: 0, max: 24, default: 6 },
  minThinkCharsForReferee: { min: 5_000, max: 200_000, default: 30_000 },
  thinkTailMinChars: { min: 1_000, max: 20_000, default: 4_000 },
  thinkTailMaxChars: { min: 2_000, max: 32_000, default: 12_000 },
  maxOutputTokens: { min: 128, max: 4_096, default: 512 },
} as const;

export interface ThinkGuardRefereeBudgetConfig {
  thinkGuardRefereeEnabled?: boolean;
  thinkGuardRefereeMaxCallsPerRun?: number;
  thinkGuardRefereeMinThinkChars?: number;
  thinkGuardRefereeThinkTailMinChars?: number;
  thinkGuardRefereeThinkTailMaxChars?: number;
  thinkGuardRefereeMaxOutputTokens?: number;
  /** Runtime counter — incremented when a referee call completes. */
  thinkGuardRefereeCallsUsed?: number;
}

export interface ResolvedThinkGuardRefereeBudget {
  enabled: boolean;
  maxCallsPerRun: number;
  callsUsed: number;
  callsRemaining: number;
  minThinkCharsForReferee: number;
  thinkTailMinChars: number;
  thinkTailMaxChars: number;
  maxOutputTokens: number;
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function resolveThinkGuardRefereeBudget(
  cfg: ThinkGuardRefereeBudgetConfig = {},
  envEnabled = false,
): ResolvedThinkGuardRefereeBudget {
  const L = THINK_GUARD_REFEREE_LIMITS;
  const enabled = cfg.thinkGuardRefereeEnabled ?? envEnabled;
  const maxCallsPerRun = clampInt(
    cfg.thinkGuardRefereeMaxCallsPerRun ?? L.maxCallsPerRun.default,
    L.maxCallsPerRun.min,
    L.maxCallsPerRun.max,
  );
  const callsUsed = Math.max(0, cfg.thinkGuardRefereeCallsUsed ?? 0);
  let thinkTailMin = clampInt(
    cfg.thinkGuardRefereeThinkTailMinChars ?? L.thinkTailMinChars.default,
    L.thinkTailMinChars.min,
    L.thinkTailMaxChars.max,
  );
  let thinkTailMax = clampInt(
    cfg.thinkGuardRefereeThinkTailMaxChars ?? L.thinkTailMaxChars.default,
    L.thinkTailMinChars.min,
    L.thinkTailMaxChars.max,
  );
  if (thinkTailMax < thinkTailMin) {
    thinkTailMax = thinkTailMin;
  }
  return {
    enabled,
    maxCallsPerRun,
    callsUsed,
    callsRemaining: Math.max(0, maxCallsPerRun - callsUsed),
    minThinkCharsForReferee: clampInt(
      cfg.thinkGuardRefereeMinThinkChars ?? L.minThinkCharsForReferee.default,
      L.minThinkCharsForReferee.min,
      L.minThinkCharsForReferee.max,
    ),
    thinkTailMinChars: thinkTailMin,
    thinkTailMaxChars: thinkTailMax,
    maxOutputTokens: clampInt(
      cfg.thinkGuardRefereeMaxOutputTokens ?? L.maxOutputTokens.default,
      L.maxOutputTokens.min,
      L.maxOutputTokens.max,
    ),
  };
}

export interface ThinkGuardRefereeReconfigPatch {
  thinkGuardRefereeEnabled?: boolean;
  thinkGuardRefereeMaxCallsPerRun?: number;
  thinkGuardRefereeMinThinkChars?: number;
  thinkGuardRefereeThinkTailMinChars?: number;
  thinkGuardRefereeThinkTailMaxChars?: number;
  thinkGuardRefereeMaxOutputTokens?: number;
}

export function patchHasThinkGuardReferee(
  patch: ThinkGuardRefereeReconfigPatch,
): boolean {
  return (
    patch.thinkGuardRefereeEnabled != null
    || patch.thinkGuardRefereeMaxCallsPerRun != null
    || patch.thinkGuardRefereeMinThinkChars != null
    || patch.thinkGuardRefereeThinkTailMinChars != null
    || patch.thinkGuardRefereeThinkTailMaxChars != null
    || patch.thinkGuardRefereeMaxOutputTokens != null
  );
}

export type ThinkGuardRefereeFieldChange<T = number | boolean> = {
  from: T | undefined;
  to: T;
};

export interface ThinkGuardRefereeReconfigChanges {
  thinkGuardRefereeEnabled?: ThinkGuardRefereeFieldChange<boolean>;
  thinkGuardRefereeMaxCallsPerRun?: ThinkGuardRefereeFieldChange<number>;
  thinkGuardRefereeMinThinkChars?: ThinkGuardRefereeFieldChange<number>;
  thinkGuardRefereeThinkTailMinChars?: ThinkGuardRefereeFieldChange<number>;
  thinkGuardRefereeThinkTailMaxChars?: ThinkGuardRefereeFieldChange<number>;
  thinkGuardRefereeMaxOutputTokens?: ThinkGuardRefereeFieldChange<number>;
}

export function applyThinkGuardRefereePatch(
  cfg: ThinkGuardRefereeBudgetConfig,
  patch: ThinkGuardRefereeReconfigPatch,
): { ok: true; changes: ThinkGuardRefereeReconfigChanges } | { ok: false; error: string } {
  const changes: ThinkGuardRefereeReconfigChanges = {};
  const L = THINK_GUARD_REFEREE_LIMITS;

  if (patch.thinkGuardRefereeEnabled != null) {
    changes.thinkGuardRefereeEnabled = {
      from: cfg.thinkGuardRefereeEnabled,
      to: patch.thinkGuardRefereeEnabled,
    };
    cfg.thinkGuardRefereeEnabled = patch.thinkGuardRefereeEnabled;
  }

  if (patch.thinkGuardRefereeMaxCallsPerRun != null) {
    const n = patch.thinkGuardRefereeMaxCallsPerRun;
    if (!Number.isInteger(n) || n < L.maxCallsPerRun.min || n > L.maxCallsPerRun.max) {
      return { ok: false, error: `thinkGuardRefereeMaxCallsPerRun must be ${L.maxCallsPerRun.min}–${L.maxCallsPerRun.max}` };
    }
    changes.thinkGuardRefereeMaxCallsPerRun = { from: cfg.thinkGuardRefereeMaxCallsPerRun, to: n };
    cfg.thinkGuardRefereeMaxCallsPerRun = n;
  }

  if (patch.thinkGuardRefereeMinThinkChars != null) {
    const n = patch.thinkGuardRefereeMinThinkChars;
    if (!Number.isInteger(n) || n < L.minThinkCharsForReferee.min || n > L.minThinkCharsForReferee.max) {
      return { ok: false, error: `thinkGuardRefereeMinThinkChars must be ${L.minThinkCharsForReferee.min}–${L.minThinkCharsForReferee.max}` };
    }
    changes.thinkGuardRefereeMinThinkChars = { from: cfg.thinkGuardRefereeMinThinkChars, to: n };
    cfg.thinkGuardRefereeMinThinkChars = n;
  }

  if (patch.thinkGuardRefereeThinkTailMinChars != null) {
    const n = patch.thinkGuardRefereeThinkTailMinChars;
    if (!Number.isInteger(n) || n < L.thinkTailMinChars.min || n > L.thinkTailMaxChars.max) {
      return { ok: false, error: `thinkGuardRefereeThinkTailMinChars out of range` };
    }
    changes.thinkGuardRefereeThinkTailMinChars = { from: cfg.thinkGuardRefereeThinkTailMinChars, to: n };
    cfg.thinkGuardRefereeThinkTailMinChars = n;
  }

  if (patch.thinkGuardRefereeThinkTailMaxChars != null) {
    const n = patch.thinkGuardRefereeThinkTailMaxChars;
    if (!Number.isInteger(n) || n < L.thinkTailMinChars.min || n > L.thinkTailMaxChars.max) {
      return { ok: false, error: `thinkGuardRefereeThinkTailMaxChars out of range` };
    }
    changes.thinkGuardRefereeThinkTailMaxChars = { from: cfg.thinkGuardRefereeThinkTailMaxChars, to: n };
    cfg.thinkGuardRefereeThinkTailMaxChars = n;
  }

  if (patch.thinkGuardRefereeMaxOutputTokens != null) {
    const n = patch.thinkGuardRefereeMaxOutputTokens;
    if (!Number.isInteger(n) || n < L.maxOutputTokens.min || n > L.maxOutputTokens.max) {
      return { ok: false, error: `thinkGuardRefereeMaxOutputTokens must be ${L.maxOutputTokens.min}–${L.maxOutputTokens.max}` };
    }
    changes.thinkGuardRefereeMaxOutputTokens = { from: cfg.thinkGuardRefereeMaxOutputTokens, to: n };
    cfg.thinkGuardRefereeMaxOutputTokens = n;
  }

  const resolved = resolveThinkGuardRefereeBudget(cfg);
  if (resolved.thinkTailMaxChars < resolved.thinkTailMinChars) {
    return { ok: false, error: "think tail max must be ≥ min" };
  }

  return { ok: true, changes };
}

export function formatThinkGuardRefereeChanges(
  changes: ThinkGuardRefereeReconfigChanges,
): string[] {
  const parts: string[] = [];
  if (changes.thinkGuardRefereeEnabled) {
    parts.push(`referee ${changes.thinkGuardRefereeEnabled.from ?? "off"} → ${changes.thinkGuardRefereeEnabled.to ? "on" : "off"}`);
  }
  if (changes.thinkGuardRefereeMaxCallsPerRun) {
    parts.push(`referee calls ${changes.thinkGuardRefereeMaxCallsPerRun.from ?? "?"} → ${changes.thinkGuardRefereeMaxCallsPerRun.to}`);
  }
  if (changes.thinkGuardRefereeMinThinkChars) {
    parts.push(`referee min think ${changes.thinkGuardRefereeMinThinkChars.from?.toLocaleString() ?? "?"} → ${changes.thinkGuardRefereeMinThinkChars.to.toLocaleString()} chars`);
  }
  if (changes.thinkGuardRefereeThinkTailMinChars || changes.thinkGuardRefereeThinkTailMaxChars) {
    const min = changes.thinkGuardRefereeThinkTailMinChars?.to;
    const max = changes.thinkGuardRefereeThinkTailMaxChars?.to;
    if (min != null && max != null) {
      parts.push(`referee tail ${min.toLocaleString()}–${max.toLocaleString()} chars`);
    } else if (min != null) {
      parts.push(`referee tail min → ${min.toLocaleString()} chars`);
    } else if (max != null) {
      parts.push(`referee tail max → ${max!.toLocaleString()} chars`);
    }
  }
  if (changes.thinkGuardRefereeMaxOutputTokens) {
    parts.push(`referee max output ${changes.thinkGuardRefereeMaxOutputTokens.from ?? "?"} → ${changes.thinkGuardRefereeMaxOutputTokens.to} tok`);
  }
  return parts;
}