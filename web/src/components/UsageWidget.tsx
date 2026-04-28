// Task #125: token-usage widget. Polls /api/usage every 10s while
// open, renders rolling-window totals with per-model + per-preset
// breakdowns. User can supply their own subscription cap (Ollama
// doesn't expose quota via API — feature request #15663 still open),
// stored in localStorage so it survives reloads.
//
// Why no defaults for caps: published Ollama Max quota numbers from
// Reddit/forum posts are unofficial guesstimates, not from Ollama
// docs. Empty caps = no progress bar; users opt in.

import { useCallback, useEffect, useRef, useState } from "react";

interface UsageBreakdownEntry {
  promptTokens: number;
  responseTokens: number;
  calls: number;
}

interface UsageWindow {
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
  calls: number;
  windowMs: number;
  windowLabel: string;
  byModel: Record<string, UsageBreakdownEntry>;
  byPreset: Record<string, UsageBreakdownEntry>;
}

interface UsageRecord {
  ts: number;
  promptTokens: number;
  responseTokens: number;
  durationMs: number;
  model?: string;
  path?: string;
  preset?: string;
}

// Task #137: proxy-side quota state. Null when no wall observed since
// the current run started; otherwise the upstream Ollama status code +
// reason snippet that tripped the detector.
// Task #149: kind distinguishes transient (concurrency burst, clears
// in seconds) from persistent (real plan/usage limit).
interface QuotaState {
  since: number;
  reason: string;
  statusCode: number;
  kind?: "transient" | "persistent";
}

interface UsagePayload {
  last1h: UsageWindow;
  last5h: UsageWindow;
  last24h: UsageWindow;
  last7d: UsageWindow;
  lifetime: { promptTokens: number; responseTokens: number; calls: number };
  // Task #169: lifetime as a UsageWindow (with byModel + byPreset)
  // so the All-time toggle can render the same breakdown tables.
  lifetimeWindow?: UsageWindow;
  recent: UsageRecord[];
  quota?: QuotaState | null;
}

// Task #185: single coalesced poll. When the panel is open, we want
// the breakdown tables to refresh every POLL_OPEN_MS (10s). When the
// panel is closed, we still need a slower background tick so the
// header chip + quota state stay current — POLL_CLOSED_MS (30s) is
// plenty since it only drives the header. Two separate intervals were
// creating a thundering-herd at every 30s boundary while open.
const POLL_OPEN_MS = 10_000;
const POLL_CLOSED_MS = 30_000;

// localStorage keys for user-supplied caps. Numbers stored as strings.
// #239 (2026-04-28): aligned to user-friendly labels — hourly / daily /
// weekly / all-time. Replaced "5h" (oddball) with "all" so the panel
// shows the natural rhythm: 1h, 1d, 1w, ∞.
const CAP_KEYS = {
  "1h": "ollama-swarm:cap:1h",
  "1d": "ollama-swarm:cap:1d",
  "1w": "ollama-swarm:cap:1w",
  "all": "ollama-swarm:cap:all",
} as const;

type WindowKey = keyof typeof CAP_KEYS;

function readCap(key: WindowKey): number | null {
  try {
    const raw = localStorage.getItem(CAP_KEYS[key]);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
function writeCap(key: WindowKey, value: number | null): void {
  try {
    if (value === null || value <= 0) {
      localStorage.removeItem(CAP_KEYS[key]);
    } else {
      localStorage.setItem(CAP_KEYS[key], String(value));
    }
  } catch {
    // storage disabled — silent.
  }
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function pctColor(pct: number): string {
  if (pct < 50) return "bg-emerald-500";
  if (pct < 80) return "bg-amber-500";
  return "bg-rose-500";
}

export function UsageWidget() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<UsagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caps, setCaps] = useState<Record<WindowKey, number | null>>(() => ({
    "1h": readCap("1h"),
    "1d": readCap("1d"),
    "1w": readCap("1w"),
    "all": readCap("all"),
  }));
  // Used as a "live snapshot" badge in the header even when closed —
  // shows the current 1h total so the user has at-a-glance awareness
  // without opening the panel. Polled once on mount, then while open.
  const [headerSnap, setHeaderSnap] = useState<number>(0);
  // Task #169 + #239 (2026-04-28): scope toggle for the breakdown
  // tables. Now offers all four windows for symmetry with the cards
  // above. Default "1d" (daily) — the most common useful view.
  // Records persist across dev-server restarts (#239) so "all" is
  // genuinely cross-session lifetime.
  const [scope, setScope] = useState<"1h" | "1d" | "1w" | "all">("1d");
  // Task #139: quota-wall state, polled independently of `open` so
  // the header chip flips red as soon as the proxy detects a wall.
  const [quota, setQuota] = useState<QuotaState | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchUsage = useCallback(async () => {
    try {
      const r = await fetch("/api/usage");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as UsagePayload;
      setData(body);
      setHeaderSnap(body.last1h.totalTokens);
      setQuota(body.quota ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Task #185: single coalesced poll. Switches cadence based on `open`:
  // 10s while open (drives breakdown tables), 30s while closed (drives
  // header chip + quota detection). Refetches immediately when the
  // panel toggles so the user never sees a stale snapshot. Replaces
  // two overlapping intervals that double-hit /api/usage at 30s marks.
  useEffect(() => {
    void fetchUsage();
    const interval = open ? POLL_OPEN_MS : POLL_CLOSED_MS;
    pollTimerRef.current = setInterval(fetchUsage, interval);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [open, fetchUsage]);

  const setCap = useCallback((key: WindowKey, value: number | null) => {
    writeCap(key, value);
    setCaps((c) => ({ ...c, [key]: value }));
  }, []);

  // Task #139 + #149 + #159: header chip styling reflects quota KIND.
  //   no quota              → default ink chip
  //   transient (concurrency)→ amber chip, no pulse — informational
  //   persistent (plan limit)→ red pulsing chip — alarming
  const chipBaseCls = "rounded px-2 py-0.5 border transition flex items-center gap-1.5";
  const isPersistent = quota?.kind === "persistent";
  const isTransient = quota?.kind === "transient" || (!!quota && !quota.kind);
  const chipCls = isPersistent
    ? `${chipBaseCls} text-rose-100 hover:text-white bg-rose-900/60 hover:bg-rose-900/80 border-rose-700/70 hover:border-rose-600 animate-pulse`
    : isTransient
      ? `${chipBaseCls} text-amber-100 hover:text-white bg-amber-900/40 hover:bg-amber-900/60 border-amber-700/60 hover:border-amber-600`
      : `${chipBaseCls} text-ink-400 hover:text-ink-100 hover:bg-ink-800/70 border-ink-700 hover:border-ink-600`;
  const chipLabel = isPersistent ? "⚠ QUOTA WALL" : isTransient ? "throttled" : "tokens";
  const chipSubtle = isPersistent
    ? `${quota!.statusCode}`
    : isTransient
      ? `429 burst`
      : `${fmtTokens(headerSnap)}/1h`;
  const chipTitle = isPersistent
    ? `Persistent Ollama quota wall (${quota!.statusCode}) — click for details`
    : isTransient
      ? "Transient concurrency throttle — clears automatically. Click for details."
      : "Token usage — click to expand";

  const dismissQuota = useCallback(async () => {
    try {
      await fetch("/api/usage/clear-quota", { method: "POST" });
      setQuota(null);
    } catch {
      // silent — next poll will refresh state anyway
    }
  }, []);

  return (
    <span className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={chipTitle}
        className={chipCls}
      >
        <span>{chipLabel}</span>
        <span className={`font-mono text-[10px] ${isPersistent ? "text-rose-200" : isTransient ? "text-amber-200" : "text-ink-500"}`}>
          {chipSubtle}
        </span>
        <span>{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div className="absolute z-20 right-0 mt-1 w-[min(720px,calc(100vw-2rem))] rounded border border-ink-600 bg-ink-900 shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-700 flex items-center justify-between text-[11px] text-ink-400">
            <span>
              Token usage
              {data ? (
                <span className="ml-2 text-ink-500">
                  · {fmtTokens(data.lifetime.promptTokens + data.lifetime.responseTokens)} lifetime
                </span>
              ) : null}
            </span>
            <button onClick={() => setOpen(false)} className="text-ink-500 hover:text-ink-200">✕</button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto p-3 space-y-3">
            {/* Task #139 + #149 + #159: quota-wall banner with kind-aware
                styling. Persistent walls (real plan limit) show as a red
                alarm; transient bursts (concurrency throttle) show as an
                amber informational notice. Both have a Dismiss button so
                stale flags can be cleared without starting a new run. */}
            {quota ? (
              <QuotaBanner quota={quota} onDismiss={dismissQuota} />
            ) : null}
            {error ? (
              <div className="text-rose-300 text-xs">Failed to load: {error}</div>
            ) : !data ? (
              <div className="text-ink-400 text-xs">Loading…</div>
            ) : (
              <>
                {/* Task #213: when all 4 rolling windows show identical
                    numbers, it looks like a display bug but is actually
                    "you have no calls older than 1h". Surface the oldest
                    record's age so the user can tell. The dev server
                    restart wipes the in-memory tokenTracker.records
                    buffer, so after a restart "all-time" is bounded by
                    process uptime. */}
                {(() => {
                  const oldest = data.recent.length > 0 ? data.recent[0].ts : null;
                  const allMatch =
                    data.last1h.totalTokens === data.last24h.totalTokens &&
                    data.last1h.totalTokens === data.last7d.totalTokens &&
                    data.last1h.calls > 0;
                  if (!allMatch) return null;
                  const oldestAge = oldest ? Date.now() - oldest : 0;
                  const oldestStr =
                    oldestAge < 60_000 ? `${Math.round(oldestAge / 1000)}s`
                    : oldestAge < 3_600_000 ? `${Math.round(oldestAge / 60_000)}m`
                    : `${(oldestAge / 3_600_000).toFixed(1)}h`;
                  return (
                    <div className="text-[10px] text-ink-500 px-2 py-1 rounded bg-ink-950/40 border border-ink-700/50">
                      All windows show identical numbers because the oldest call
                      is only <span className="text-ink-300 font-mono">{oldestStr}</span> old.
                      Dev-server restarts wipe the tracker buffer; data accumulates over time.
                    </div>
                  );
                })()}
                {/* #239 (2026-04-28): rolling-window cards aligned to
                    user-friendly cadence (hourly / daily / weekly /
                    all-time). Maps each card to the underlying API
                    field; "all" falls back to last7d when the server
                    doesn't ship lifetimeWindow (older builds). */}
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { key: "1h" as const, win: data.last1h, label: "1h" },
                    { key: "1d" as const, win: data.last24h, label: "1d" },
                    { key: "1w" as const, win: data.last7d, label: "1w" },
                    { key: "all" as const, win: data.lifetimeWindow ?? data.last7d, label: "all" },
                  ]).map(({ key, win, label }) => (
                    <WindowCard
                      key={key}
                      label={label}
                      window={win}
                      cap={caps[key]}
                      onCapChange={(v) => setCap(key, v)}
                    />
                  ))}
                </div>
                {/* #239 (2026-04-28): 4-option scope toggle —
                    matches the cards above (1h / 1d / 1w / all). Lets
                    users see byModel/byPreset breakdown for the same
                    cadence they're inspecting in the totals. Records
                    are now persisted across dev-server restarts so
                    "all" is genuinely cross-session. */}
                <div className="flex items-center gap-2 text-[11px] text-ink-400">
                  <span>Breakdown scope:</span>
                  <div className="inline-flex rounded border border-ink-700 overflow-hidden">
                    {([
                      { k: "1h" as const, label: "Hourly", title: "Calls in the last hour." },
                      { k: "1d" as const, label: "Daily", title: "Calls in the last 24 hours." },
                      { k: "1w" as const, label: "Weekly", title: "Calls in the last 7 days." },
                      { k: "all" as const, label: "All time", title: "Every call we have on disk (persisted across dev-server restarts; ~30 days retention)." },
                    ]).map(({ k, label, title }) => (
                      <button
                        key={k}
                        onClick={() => setScope(k)}
                        className={`px-2 py-0.5 ${scope === k ? "bg-ink-700 text-ink-100" : "hover:bg-ink-800 text-ink-400"}`}
                        title={title}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Per-model + per-preset breakdowns — source switches
                    based on toggle. */}
                {(() => {
                  const win = scope === "all"
                    ? (data.lifetimeWindow ?? data.last7d)
                    : scope === "1w"
                      ? data.last7d
                      : scope === "1h"
                        ? data.last1h
                        : data.last24h;
                  const scopeLabel = scope === "all" ? "all time" : scope === "1w" ? "last 7 days" : scope === "1h" ? "last hour" : "last 24 hours";
                  const empty = `(no calls in ${scopeLabel})`;
                  return (
                    <>
                      <BreakdownTable
                        title={`By model · ${scopeLabel}`}
                        rows={win.byModel}
                        empty={empty}
                      />
                      <BreakdownTable
                        title={`By preset · ${scopeLabel}`}
                        rows={win.byPreset}
                        empty={empty}
                      />
                    </>
                  );
                })()}
                {/* Recent calls */}
                <RecentTable rows={data.recent.slice(-15).reverse()} />
              </>
            )}
          </div>
        </div>
      ) : null}
    </span>
  );
}

// Task #159: kind-aware quota banner. Persistent = red sticky alarm;
// transient = amber informational notice with auto-clear note.
function QuotaBanner({ quota, onDismiss }: { quota: QuotaState; onDismiss: () => void }) {
  const isPersistent = quota.kind === "persistent";
  const palette = isPersistent
    ? {
        outer: "border-rose-700 bg-rose-950/60",
        title: "text-rose-100",
        body: "text-rose-200",
        meta: "text-rose-300/80",
        button: "border-rose-600 text-rose-100 hover:bg-rose-800/50",
      }
    : {
        outer: "border-amber-700/70 bg-amber-950/40",
        title: "text-amber-100",
        body: "text-amber-200",
        meta: "text-amber-300/80",
        button: "border-amber-600 text-amber-100 hover:bg-amber-800/50",
      };
  return (
    <div className={`rounded border-2 ${palette.outer} px-3 py-2 text-xs space-y-1`}>
      <div className="flex items-center justify-between gap-2">
        <div className={`font-semibold ${palette.title}`}>
          {isPersistent
            ? `⚠ Persistent quota wall (HTTP ${quota.statusCode})`
            : `⚠ Transient throttle (HTTP ${quota.statusCode})`}
        </div>
        <button
          onClick={onDismiss}
          title="Dismiss this notice (clears the quota flag without starting a new run)"
          className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider ${palette.button}`}
        >
          Dismiss
        </button>
      </div>
      <div className={`${palette.body} font-mono break-words`}>{quota.reason}</div>
      <div className={palette.meta}>
        Detected at {new Date(quota.since).toLocaleTimeString()}.
        {isPersistent
          ? " In-flight runs stopped cleanly via Task #137. The next run start clears this flag so it can re-probe the wall."
          : " Concurrency burst — Ollama un-throttled within seconds. Auto-clears after 5 min idle. Runs continue normally; this is informational."}
      </div>
    </div>
  );
}

function WindowCard({
  label,
  window: w,
  cap,
  onCapChange,
}: {
  label: string;
  window: UsageWindow;
  cap: number | null;
  onCapChange: (v: number | null) => void;
}) {
  const pct = cap && cap > 0 ? Math.min(100, (w.totalTokens / cap) * 100) : null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cap ? String(cap) : "");
  const commit = () => {
    const n = Number(draft);
    onCapChange(Number.isFinite(n) && n > 0 ? Math.floor(n) : null);
    setEditing(false);
  };
  return (
    <div className="rounded border border-ink-700 bg-ink-950/40 px-2 py-1.5">
      <div className="flex items-baseline justify-between mb-0.5">
        <div className="text-[10px] uppercase tracking-wider text-ink-500">last {label}</div>
        <div className="text-[10px] text-ink-500">{w.calls} calls</div>
      </div>
      <div className="font-mono text-sm text-ink-100">{fmtTokens(w.totalTokens)}</div>
      <div className="text-[9px] text-ink-500 font-mono">
        {fmtTokens(w.promptTokens)} in · {fmtTokens(w.responseTokens)} out
      </div>
      {pct !== null ? (
        <>
          <div className="mt-1 h-1.5 rounded bg-ink-800 overflow-hidden">
            <div className={`h-full ${pctColor(pct)} transition-all`} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-0.5 flex items-center justify-between text-[9px] font-mono text-ink-500">
            <span>{pct.toFixed(1)}% of cap</span>
            <button
              onClick={() => { setDraft(cap ? String(cap) : ""); setEditing(true); }}
              className="hover:text-ink-200 underline"
            >
              cap: {fmtTokens(cap!)}
            </button>
          </div>
        </>
      ) : (
        <div className="mt-1 text-[9px] font-mono text-ink-600">
          {editing ? (
            <span className="flex items-center gap-1">
              <input
                type="number"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="tokens"
                className="bg-ink-800 border border-ink-700 rounded px-1 py-0.5 w-24 text-ink-200"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
                onBlur={commit}
              />
            </span>
          ) : (
            <button onClick={() => setEditing(true)} className="hover:text-ink-300 underline">
              + set cap
            </button>
          )}
        </div>
      )}
      {pct !== null && editing ? (
        <div className="mt-1 flex items-center gap-1">
          <input
            type="number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="tokens"
            className="bg-ink-800 border border-ink-700 rounded px-1 py-0.5 w-24 text-ink-200 text-[10px] font-mono"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
            onBlur={commit}
          />
          <button onClick={() => onCapChange(null)} className="text-[9px] text-rose-300 underline">clear</button>
        </div>
      ) : null}
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: Record<string, UsageBreakdownEntry>;
  empty: string;
}) {
  const entries = Object.entries(rows).sort((a, b) => (b[1].promptTokens + b[1].responseTokens) - (a[1].promptTokens + a[1].responseTokens));
  const total = entries.reduce((sum, [, e]) => sum + e.promptTokens + e.responseTokens, 0);
  return (
    <div className="rounded border border-ink-700 bg-ink-950/30">
      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-ink-500 border-b border-ink-700/60">{title}</div>
      {entries.length === 0 ? (
        <div className="px-2 py-2 text-[10px] text-ink-500 italic">{empty}</div>
      ) : (
        <table className="w-full text-[11px] font-mono">
          <thead className="text-[9px] uppercase tracking-wider text-ink-500">
            <tr>
              <th className="px-2 py-1 text-left">Name</th>
              <th className="px-2 py-1 text-right">Calls</th>
              <th className="px-2 py-1 text-right">Tokens</th>
              <th className="px-2 py-1 text-right">%</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([name, e]) => {
              const t = e.promptTokens + e.responseTokens;
              const pct = total > 0 ? (t / total) * 100 : 0;
              return (
                <tr key={name} className="border-t border-ink-800/60">
                  <td className="px-2 py-1 text-ink-200 truncate max-w-[260px]" title={name}>{name}</td>
                  <td className="px-2 py-1 text-right text-ink-300">{e.calls}</td>
                  <td className="px-2 py-1 text-right text-ink-300">{fmtTokens(t)}</td>
                  <td className="px-2 py-1 text-right text-ink-400">{pct.toFixed(0)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RecentTable({ rows }: { rows: UsageRecord[] }) {
  return (
    <div className="rounded border border-ink-700 bg-ink-950/30">
      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-ink-500 border-b border-ink-700/60">
        Recent calls (latest 15)
      </div>
      {rows.length === 0 ? (
        <div className="px-2 py-2 text-[10px] text-ink-500 italic">(no calls yet)</div>
      ) : (
        <table className="w-full text-[10px] font-mono">
          <thead className="text-[9px] uppercase tracking-wider text-ink-500">
            <tr>
              <th className="px-2 py-1 text-left">When</th>
              <th className="px-2 py-1 text-left">Model</th>
              <th className="px-2 py-1 text-left">Preset</th>
              <th className="px-2 py-1 text-right">In</th>
              <th className="px-2 py-1 text-right">Out</th>
              <th className="px-2 py-1 text-right">Dur</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const ageS = Math.floor((Date.now() - r.ts) / 1000);
              const ageStr = ageS < 60 ? `${ageS}s` : ageS < 3600 ? `${Math.floor(ageS / 60)}m` : `${Math.floor(ageS / 3600)}h`;
              return (
                <tr key={`${r.ts}-${i}`} className="border-t border-ink-800/60">
                  <td className="px-2 py-1 text-ink-400">{ageStr} ago</td>
                  <td className="px-2 py-1 text-ink-300 truncate max-w-[140px]" title={r.model ?? ""}>{r.model ?? "?"}</td>
                  <td className="px-2 py-1 text-ink-300 truncate max-w-[100px]" title={r.preset ?? ""}>{r.preset ?? "—"}</td>
                  <td className="px-2 py-1 text-right text-ink-300">{fmtTokens(r.promptTokens)}</td>
                  <td className="px-2 py-1 text-right text-ink-300">{fmtTokens(r.responseTokens)}</td>
                  <td className="px-2 py-1 text-right text-ink-400">{r.durationMs}ms</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
