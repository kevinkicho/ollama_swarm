import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  THINK_GUARD_REFEREE_LIMITS,
  type ResolvedThinkGuardRefereeBudget,
} from "@ollama-swarm/shared/thinkGuardBudget";
import { useSwarm } from "../state/store";
import { isActiveSwarmPhase } from "../lib/swarmPhase";

type Draft = {
  enabled: boolean;
  maxCallsPerRun: number;
  minThinkChars: number;
  tailMinChars: number;
  tailMaxChars: number;
  maxOutputTokens: number;
};

function draftFromBudget(b: ResolvedThinkGuardRefereeBudget): Draft {
  return {
    enabled: b.enabled,
    maxCallsPerRun: b.maxCallsPerRun,
    minThinkChars: b.minThinkCharsForReferee,
    tailMinChars: b.thinkTailMinChars,
    tailMaxChars: b.thinkTailMaxChars,
    maxOutputTokens: b.maxOutputTokens,
  };
}

function NumField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] text-ink-500">{label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={disabled || value - step < min}
          onClick={() => onChange(Math.max(min, value - step))}
          className="px-1.5 py-0.5 rounded border border-ink-700 text-ink-400 hover:text-ink-200 disabled:opacity-40"
        >
          −
        </button>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
          }}
          className="w-20 bg-ink-950 border border-ink-700 rounded px-1 py-0.5 text-[11px] text-ink-100 tabular-nums text-center"
        />
        <button
          type="button"
          disabled={disabled || value + step > max}
          onClick={() => onChange(Math.min(max, value + step))}
          className="px-1.5 py-0.5 rounded border border-ink-700 text-ink-400 hover:text-ink-200 disabled:opacity-40"
        >
          +
        </button>
      </div>
    </label>
  );
}

export function ThinkGuardRefereePanel() {
  const runId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);
  const budget = useSwarm((s) => s.thinkGuardReferee);
  const runConfig = useSwarm((s) => s.runConfig);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = isActiveSwarmPhase(phase);
  const L = THINK_GUARD_REFEREE_LIMITS;

  const resolvedBudget: ResolvedThinkGuardRefereeBudget = budget ?? {
    enabled: false,
    maxCallsPerRun: L.maxCallsPerRun.default,
    callsUsed: 0,
    callsRemaining: L.maxCallsPerRun.default,
    minThinkCharsForReferee: L.minThinkCharsForReferee.default,
    thinkTailMinChars: L.thinkTailMinChars.default,
    thinkTailMaxChars: L.thinkTailMaxChars.default,
    maxOutputTokens: L.maxOutputTokens.default,
  };

  const syncPanelPosition = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: Math.max(8, rect.left - 80) });
  };

  const closePanel = () => {
    setOpen(false);
    setError(null);
  };

  const openPanel = () => {
    syncPanelPosition();
    setOpen(true);
    if (!draft) setDraft(draftFromBudget(resolvedBudget));
    setError(null);
  };

  useEffect(() => {
    if (budget) setDraft(draftFromBudget(budget));
  }, [budget]);

  useEffect(() => {
    if (!open) return;
    const onLayout = () => syncPanelPosition();
    window.addEventListener("resize", onLayout);
    window.addEventListener("scroll", onLayout, true);
    return () => {
      window.removeEventListener("resize", onLayout);
      window.removeEventListener("scroll", onLayout, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      closePanel();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!runId || !runConfig) return null;

  const b = resolvedBudget;

  const chipStyle = !b.enabled
    ? "bg-ink-800/60 text-ink-500 border-ink-700/50"
    : b.callsRemaining <= 1
      ? "bg-amber-900/40 text-amber-300 border-amber-800/50"
      : "bg-fuchsia-900/35 text-fuchsia-300 border-fuchsia-800/50";

  const chipLabel = b.enabled
    ? `referee ${b.callsUsed}/${b.maxCallsPerRun}`
    : "referee off";

  const apply = async () => {
    if (!runId || !draft || !live) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { runId };
    if (draft.enabled !== b.enabled) body.thinkGuardRefereeEnabled = draft.enabled;
    if (draft.maxCallsPerRun !== b.maxCallsPerRun) {
      body.thinkGuardRefereeMaxCallsPerRun = draft.maxCallsPerRun;
    }
    if (draft.minThinkChars !== b.minThinkCharsForReferee) {
      body.thinkGuardRefereeMinThinkChars = draft.minThinkChars;
    }
    if (draft.tailMinChars !== b.thinkTailMinChars) {
      body.thinkGuardRefereeThinkTailMinChars = draft.tailMinChars;
    }
    if (draft.tailMaxChars !== b.thinkTailMaxChars) {
      body.thinkGuardRefereeThinkTailMaxChars = draft.tailMaxChars;
    }
    if (draft.maxOutputTokens !== b.maxOutputTokens) {
      body.thinkGuardRefereeMaxOutputTokens = draft.maxOutputTokens;
    }
    if (Object.keys(body).length === 1) {
      setError("No changes to apply");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch("/api/swarm/reconfig", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      closePanel();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (open) closePanel();
          else openPanel();
        }}
        className={`inline-flex items-center gap-1 px-1.5 py-px rounded border font-mono text-[10px] transition ${chipStyle} ${
          open ? "ring-1 ring-fuchsia-600/60" : ""
        }`}
        title="Think-stream referee budget — click to configure; click away to close"
      >
        <span>{chipLabel}</span>
        {b.enabled ? (
          <span className="text-[9px] opacity-80">{b.callsRemaining} left</span>
        ) : null}
      </button>
      {open && pos && draft
        ? createPortal(
            <div
              ref={panelRef}
              className="fixed z-[9999] w-[min(380px,calc(100vw-16px))] rounded-lg border border-ink-600 bg-ink-900/95 shadow-2xl backdrop-blur p-3 text-xs font-mono text-ink-200"
              style={{ top: pos.top, left: pos.left }}
            >
              <div className="text-[10px] uppercase tracking-wider text-ink-500 mb-2">
                Think-guard referee
              </div>
              <p className="text-[10px] text-ink-500 leading-snug mb-3">
                Second-look triage when a think-only stream hits soft/hard caps. Adjust mid-run;
                Brain can also suggest RECONFIG patches.
              </p>

              <div className="flex flex-wrap gap-2 mb-3">
                <span className="px-1.5 py-px rounded border bg-ink-800 text-ink-300 border-ink-700">
                  used: {b.callsUsed}
                </span>
                <span className="px-1.5 py-px rounded border bg-ink-800 text-ink-300 border-ink-700">
                  remaining: {b.callsRemaining}
                </span>
                <label className="inline-flex items-center gap-1.5 ml-auto cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    disabled={!live || busy}
                    onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                    className="accent-fuchsia-500"
                  />
                  <span className="text-[10px] text-ink-400">enabled</span>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-3">
                <NumField
                  label={`max calls (${L.maxCallsPerRun.min}–${L.maxCallsPerRun.max})`}
                  value={draft.maxCallsPerRun}
                  min={L.maxCallsPerRun.min}
                  max={L.maxCallsPerRun.max}
                  disabled={!live || busy}
                  onChange={(n) => setDraft({ ...draft, maxCallsPerRun: n })}
                />
                <NumField
                  label={`min think chars`}
                  value={draft.minThinkChars}
                  min={L.minThinkCharsForReferee.min}
                  max={L.minThinkCharsForReferee.max}
                  step={1000}
                  disabled={!live || busy}
                  onChange={(n) => setDraft({ ...draft, minThinkChars: n })}
                />
                <NumField
                  label="tail min chars"
                  value={draft.tailMinChars}
                  min={L.thinkTailMinChars.min}
                  max={L.thinkTailMaxChars.max}
                  step={500}
                  disabled={!live || busy}
                  onChange={(n) => setDraft({ ...draft, tailMinChars: n })}
                />
                <NumField
                  label="tail max chars"
                  value={draft.tailMaxChars}
                  min={L.thinkTailMinChars.min}
                  max={L.thinkTailMaxChars.max}
                  step={500}
                  disabled={!live || busy}
                  onChange={(n) => setDraft({ ...draft, tailMaxChars: Math.max(n, draft.tailMinChars) })}
                />
                <NumField
                  label={`max output tok`}
                  value={draft.maxOutputTokens}
                  min={L.maxOutputTokens.min}
                  max={L.maxOutputTokens.max}
                  step={64}
                  disabled={!live || busy}
                  onChange={(n) => setDraft({ ...draft, maxOutputTokens: n })}
                />
              </div>

              {!live ? (
                <p className="text-[10px] text-ink-500 mb-2">Run ended — settings are read-only.</p>
              ) : null}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!live || busy}
                  onClick={() => void apply()}
                  className="text-[10px] uppercase tracking-wide px-2 py-1 rounded bg-fuchsia-800 hover:bg-fuchsia-700 disabled:bg-ink-700 disabled:text-ink-500 text-fuchsia-100"
                >
                  {busy ? "Applying…" : "Apply"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => budget && setDraft(draftFromBudget(budget))}
                  className="text-[10px] text-ink-500 hover:text-ink-300"
                >
                  reset
                </button>
              </div>
              {error ? <p className="mt-1.5 text-[10px] text-rose-300">{error}</p> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}