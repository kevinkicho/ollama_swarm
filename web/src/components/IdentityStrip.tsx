import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSwarm } from "../state/store";
import { useEventLogStream } from "../hooks/useEventLogStream";

// E2 incremental cutover (#336): when ?useEventLogRunId=1 is set in the
// URL, the run-id chip pulls from the event-log stream instead of the
// WebSocket-derived store. Smallest practical "wire one field to the
// event-log source" step — proves the data path on a single value
// before generalizing to phase / preset / counts. Default: WS source
// (unchanged behavior).
function shouldUseEventLogRunId(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("useEventLogRunId");
}
import { CopyChip } from "./CopyChip";
import type { ConformanceSample, DriftSample } from "../state/store";

// Truncate-from-LEFT (per Kevin's Unit 52c spec preference): the
// distinguishing tail of a path is the run-name + repo-name, not the
// shared `/mnt/c/Users/...` prefix.
export function truncateLeft(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return "…" + s.slice(s.length - maxLen + 1);
}

// Unit 52c (Unit 56-consolidated): single run-identity topbar showing
// run uuid + run name + preset + planner/worker models + agent count
// + clone path. The path is click-to-open via POST /api/swarm/open
// (server validates the request matches the active run's clonePath,
// then shells out to Explorer/Finder/xdg-open). Per-agent session ids
// + models live in the AgentPanel cards (Unit 56) — this strip only
// carries run-level metadata.
export function IdentityStrip() {
  const cfg = useSwarm((s) => s.runConfig);
  const wsRunId = useSwarm((s) => s.runId);
  // Always subscribe to the event-log stream so the hook stays warm —
  // the conditional consumes the value but the subscription cost is
  // negligible (one fetch every 10s shared across all consumers).
  const eventLog = useEventLogStream();
  const runId = shouldUseEventLogRunId()
    ? eventLog.runs[eventLog.runs.length - 1]?.derived.runId ?? wsRunId
    : wsRunId;
  const conformance = useSwarm((s) => s.conformance);
  const drift = useSwarm((s) => s.drift);
  const phase = useSwarm((s) => s.phase);
  const amendments = useSwarm((s) => s.amendments);
  // Task #85: history dropdown moved to the App-level header so it's
  // also reachable from the SetupForm. IdentityStrip no longer
  // renders it — keep `history = null` so existing layout doesn't
  // shift when this strip appears.
  const history = null;
  if (!cfg && !runId) return null;
  const runName = cfg ? deriveRunName(cfg.clonePath) : "(unnamed run)";
  const onOpen = async () => {
    if (!cfg) return;
    // Task #45: retry on TypeError: Failed to fetch (tsx-watch restart
    // window makes the backend briefly unreachable — 2-5s typical).
    // Retry 3 times with 500ms backoff before giving up.
    const attemptOnce = async (): Promise<{ ok: boolean; err?: unknown }> => {
      try {
        const res = await fetch("/api/swarm/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: cfg.clonePath }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { ok: false, err: body.error ?? `HTTP ${res.status}` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, err };
      }
    };
    for (let i = 0; i < 3; i++) {
      const result = await attemptOnce();
      if (result.ok) return;
      // Only retry on TypeError (network-level). HTTP errors are permanent.
      if (!(result.err instanceof TypeError)) {
        console.warn("open clone path failed:", result.err);
        return;
      }
      if (i < 2) {
        await new Promise((r) => setTimeout(r, 500));
      } else {
        console.warn("open clone path failed after 3 retries:", result.err);
      }
    }
  };
  const sameModel = cfg && cfg.plannerModel === cfg.workerModel;
  return (
    <div className="bg-ink-900/60 border-b border-ink-700 px-4 py-1.5 flex items-center gap-2.5 text-xs font-mono text-ink-300 flex-wrap">
      {runId ? (
        <CopyChip label="run" value={runId} short={runId.slice(0, 8)} />
      ) : null}
      {/* Task #35: preset badge immediately after the runId chip — they're
          the two most-scanned anchors in the strip, and pairing them lets
          users instantly see "this is the {preset} run with id {short}".
          Uppercase pill style is intentional: visually distinct from the
          monospace runId and the model chips. */}
      {cfg ? (
        <PresetBadge preset={cfg.preset} />
      ) : null}
      {cfg ? (
        <>
          <span className="text-ink-600">·</span>
          <span className="text-ink-100 font-semibold">{runName}</span>
          <span className="text-ink-600">·</span>
          {sameModel ? (
            <span title="Planner + worker model"><span className="text-ink-500">model</span> {cfg.plannerModel}</span>
          ) : (
            <>
              <span title="Planner model"><span className="text-ink-500">planner</span> {cfg.plannerModel}</span>
              <span className="text-ink-600">·</span>
              <span title="Worker model"><span className="text-ink-500">worker</span> {cfg.workerModel}</span>
            </>
          )}
          {/* Topbar dedup: dropped the "agents N" segment. cfg.agentCount
              excludes the dedicated auditor (Unit 58) so the count was
              wrong for 4-agent runs, and the live agent count is already
              in the left sidebar header. Dedup over fix-the-count. */}
          <ConformanceGauge samples={conformance} drift={drift} />
          {runId && phase !== "idle" && phase !== "completed" && phase !== "stopped" ? (
            <AmendButton runId={runId} amendmentCount={amendments.length} />
          ) : null}
          <button
            onClick={onOpen}
            title={`Open in OS file manager — ${cfg.clonePath}`}
            className="text-ink-400 hover:text-ink-100 hover:underline truncate max-w-md inline-block align-bottom ml-auto"
          >
            {truncateLeft(cfg.clonePath, 60)}
          </button>
        </>
      ) : null}
      {history}
    </div>
  );
}

// #295 + #301: real-time conformance gauge. Renders nothing when no
// samples have arrived (most runs without a userDirective; or first
// ~90s before the first poll lands). On hover, opens a portal-based
// infographic tooltip showing how the score is computed.
//
// Color grading:
//   ≥ 70 = emerald (on-topic)
//   40–69 = amber (mixed/drifting)
//   < 40 = rose (drifted)
function ConformanceGauge({
  samples,
  drift,
}: {
  samples: ReadonlyArray<ConformanceSample>;
  drift: ReadonlyArray<DriftSample>;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  if (samples.length === 0) return null;
  const latest = samples[samples.length - 1];
  const score = latest.smoothedScore;
  const color =
    score >= 70 ? "text-emerald-300"
    : score >= 40 ? "text-amber-300"
    : "text-rose-300";
  const stroke =
    score >= 70 ? "stroke-emerald-400"
    : score >= 40 ? "stroke-amber-400"
    : "stroke-rose-400";
  // Build a 60×14 SVG sparkline of smoothed scores
  const W = 60, H = 14;
  const xs = samples.map((_, i) => (samples.length === 1 ? 0 : (i / (samples.length - 1)) * W));
  const ys = samples.map((s) => H - (Math.max(0, Math.min(100, s.smoothedScore)) / 100) * H);
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const onEnter = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: rect.left });
  };
  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={onEnter}
        onMouseLeave={() => setPos(null)}
        className={`inline-flex items-center gap-1.5 ml-3 cursor-help ${color}`}
      >
        <span className="text-[9px] uppercase tracking-wider text-ink-500">conf</span>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
          <path d={path} className={stroke} fill="none" strokeWidth={1.25} />
        </svg>
        <span className="font-mono text-[11px] tabular-nums">{score}</span>
      </span>
      {pos
        ? createPortal(
            <ConformanceTooltip latest={latest} samples={samples} drift={drift} pos={pos} />,
            document.body,
          )
        : null}
    </>
  );
}

// #301 Phase A + #302 Phase B: rich infographic tooltip showing how
// the conformance score is computed (Phase A) and how it correlates
// with an independent embedding-similarity signal (Phase B). When
// the embedding model isn't pulled, the drift section surfaces a
// "pull <model> to enable" hint instead of a sparkline.
function ConformanceTooltip({
  latest,
  samples,
  drift,
  pos,
}: {
  latest: ConformanceSample;
  samples: ReadonlyArray<ConformanceSample>;
  drift: ReadonlyArray<DriftSample>;
  pos: { top: number; left: number };
}) {
  const score = latest.smoothedScore;
  const accent =
    score >= 70 ? { text: "text-emerald-300", bar: "bg-emerald-500", label: "ON-TOPIC" }
    : score >= 40 ? { text: "text-amber-300", bar: "bg-amber-500", label: "DRIFTING" }
    : { text: "text-rose-300", bar: "bg-rose-500", label: "DRIFTED" };
  const window = latest.windowScores ?? [];
  const latestDrift = drift.length > 0 ? drift[drift.length - 1] : null;
  return (
    <div
      className="fixed z-50 bg-ink-900 border border-ink-600 rounded-md p-3 shadow-xl pointer-events-none text-[11px]"
      style={{ top: pos.top, left: pos.left, width: 360 }}
    >
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-[9px] uppercase tracking-wider text-ink-500">
          conformance to directive
        </div>
        <div className={`text-[9px] uppercase tracking-wider font-semibold ${accent.text}`}>
          {accent.label}
        </div>
      </div>
      {/* Big colored score */}
      <div className="flex items-baseline gap-2 mb-2">
        <span className={`text-3xl font-mono font-semibold tabular-nums ${accent.text}`}>{score}</span>
        <span className="text-ink-500 text-[10px]">/ 100 (smoothed)</span>
      </div>
      {/* Score bar */}
      <div className="h-1.5 bg-ink-950 rounded overflow-hidden mb-3">
        <div className={`h-full ${accent.bar}`} style={{ width: `${score}%` }} />
      </div>

      {/* Smoothing window — last 3 raw scores */}
      {window.length > 0 ? (
        <div className="mb-2">
          <div className="text-[9px] uppercase tracking-wider text-ink-500 mb-1">
            smoothing window (last {window.length})
          </div>
          <div className="flex items-end gap-1 h-8">
            {window.map((s, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                <div
                  className="w-full bg-ink-700 rounded-t"
                  style={{ height: `${Math.max(2, s)}%` }}
                />
                <span className="text-[9px] font-mono text-ink-400 tabular-nums">{s}</span>
              </div>
            ))}
          </div>
          <div className="text-[9px] text-ink-500 mt-0.5">
            mean = {Math.round(window.reduce((a, b) => a + b, 0) / window.length)} → smoothed score
          </div>
        </div>
      ) : null}

      {/* Phase B: independent embedding-similarity signal */}
      <div className="mt-2 pt-2 border-t border-ink-700">
        <div className="flex items-baseline justify-between mb-1">
          <div className="text-[9px] uppercase tracking-wider text-ink-500">
            embedding similarity (independent signal)
          </div>
          {latestDrift ? (
            <span className="text-[9px] font-mono tabular-nums text-ink-300">
              {latestDrift.smoothedSimilarity}/100
            </span>
          ) : null}
        </div>
        {latestDrift ? (
          <>
            <div className="h-1.5 bg-ink-950 rounded overflow-hidden">
              <div
                className="h-full bg-sky-500/70"
                style={{ width: `${latestDrift.smoothedSimilarity}%` }}
              />
            </div>
            <AgreementHint llmJudge={score} embedding={latestDrift.smoothedSimilarity} />
            <div className="text-[9px] text-ink-500 mt-0.5">
              via <span className="font-mono">{latestDrift.embeddingModel}</span> · cosine
              of directive vs last {latestDrift.excerptChars.toLocaleString()} chars
            </div>
          </>
        ) : (
          <div className="text-[10px] text-amber-300/80 leading-snug">
            Drift gauge inactive. Run{" "}
            <code className="bg-ink-950/60 px-1 rounded font-mono text-[10px]">
              ollama pull nomic-embed-text
            </code>{" "}
            to enable a second independent signal.
          </div>
        )}
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] mt-2 border-t border-ink-700 pt-2">
        {latest.graderModel ? (
          <>
            <span className="text-ink-500">grader</span>
            <span className="font-mono text-ink-300 truncate" title={latest.graderModel}>
              {latest.graderModel}
            </span>
          </>
        ) : null}
        {typeof latest.latencyMs === "number" ? (
          <>
            <span className="text-ink-500">grader latency</span>
            <span className="font-mono text-ink-300">{(latest.latencyMs / 1000).toFixed(1)}s</span>
          </>
        ) : null}
        {typeof latest.excerptChars === "number" ? (
          <>
            <span className="text-ink-500">excerpt size</span>
            <span className="font-mono text-ink-300">
              {latest.excerptChars.toLocaleString()} chars
            </span>
          </>
        ) : null}
        <span className="text-ink-500">samples so far</span>
        <span className="font-mono text-ink-300">{samples.length}</span>
        <span className="text-ink-500">poll interval</span>
        <span className="font-mono text-ink-300">90s</span>
      </div>

      {/* Grader's reason for the LATEST score */}
      {latest.reason ? (
        <div className="mt-2 pt-2 border-t border-ink-700 text-ink-300 leading-snug italic">
          “{latest.reason}”
        </div>
      ) : null}
    </div>
  );
}

// Task #35: pill-style badge for the active preset, rendered right
// after the runId chip in IdentityStrip. Per-preset color so a quick
// glance distinguishes a write-capable blackboard run from a read-
// only discussion preset. Uppercase + tracking for visual weight
// against the surrounding monospace chips.
function PresetBadge({ preset }: { preset: string }) {
  // Color buckets: write-capable = emerald (signals "this run will
  // change files"); read-only discussion presets = ink-blue tones.
  // Debate-judge (PRO/CON dynamic) gets amber. Stigmergy (self-
  // organizing) gets teal. Council/role-diff/orchestrator-worker/
  // map-reduce/round-robin share a neutral indigo.
  const palette = ((): { bg: string; fg: string; border: string } => {
    switch (preset) {
      case "blackboard":
        return { bg: "bg-emerald-900/40", fg: "text-emerald-200", border: "border-emerald-700" };
      case "debate-judge":
        return { bg: "bg-amber-900/30", fg: "text-amber-200", border: "border-amber-700" };
      case "stigmergy":
        return { bg: "bg-teal-900/30", fg: "text-teal-200", border: "border-teal-700" };
      default:
        return { bg: "bg-indigo-900/30", fg: "text-indigo-200", border: "border-indigo-700" };
    }
  })();
  return (
    <span
      title={`Preset: ${preset}`}
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wider font-semibold ${palette.bg} ${palette.fg} ${palette.border}`}
    >
      {preset}
    </span>
  );
}

// #302 Phase B: agreement-hint between LLM-judge and embedding signals.
// When both methods land within 15 points of each other, that's high
// confidence in the score. Disagreement signals noise — either the
// LLM-judge is biased OR the embedding picked up incidental similarity.
function AgreementHint({ llmJudge, embedding }: { llmJudge: number; embedding: number }) {
  const delta = Math.abs(llmJudge - embedding);
  if (delta <= 15) {
    return (
      <div className="text-[9px] text-emerald-300/80 mt-0.5">
        ✓ Both signals agree (Δ = {delta} pts) — high confidence.
      </div>
    );
  }
  if (delta <= 30) {
    return (
      <div className="text-[9px] text-amber-300/80 mt-0.5">
        Signals partly disagree (Δ = {delta} pts) — treat as noisy.
      </div>
    );
  }
  return (
    <div className="text-[9px] text-rose-300/80 mt-0.5">
      Signals disagree strongly (Δ = {delta} pts) — score may be unreliable.
    </div>
  );
}

// #299: HITL amend button + popover. Only mounts during a live run.
// Click opens an inline popover with a textarea + submit button;
// POSTs to /api/swarm/amend which broadcasts a directive_amended
// event (handled by useSwarmSocket → store.pushAmendment) so the
// gauge area shows the new amendment count without any local state
// roundtrip. The runner picks it up at the next planner-tier prompt.
function AmendButton({
  runId,
  amendmentCount,
}: {
  runId: string;
  amendmentCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSubmit = async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/swarm/amend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, text: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setText("");
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="relative inline-block ml-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Submit a mid-run nudge — agents pick it up at next planner cycle"
        className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-ink-600 text-ink-300 hover:text-ink-100 hover:border-ink-400"
      >
        + nudge{amendmentCount > 0 ? ` (${amendmentCount})` : ""}
      </button>
      {open ? (
        <div className="absolute z-30 top-full mt-1 right-0 w-80 bg-ink-900 border border-ink-600 rounded shadow-xl p-2">
          <div className="text-[10px] text-ink-400 mb-1">
            Mid-run nudge — appended to the directive at the next planner-tier prompt.
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 1000))}
            placeholder="e.g. Focus on the auth module instead — skip the README work for now."
            rows={3}
            disabled={busy}
            className="w-full bg-ink-950 border border-ink-700 rounded p-1.5 text-[12px] text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-ink-500 resize-y"
            style={{ fontFamily: "inherit" }}
          />
          <div className="flex items-center gap-2 mt-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="text-[10px] uppercase tracking-wide px-2 py-1 rounded text-ink-400 hover:text-ink-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={busy || text.trim().length === 0}
              className="text-[10px] uppercase tracking-wide px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-ink-700 disabled:text-ink-500 text-emerald-100 ml-auto"
            >
              {busy ? "Sending…" : "Submit nudge"}
            </button>
          </div>
          {error ? (
            <div className="mt-1 text-[10px] text-rose-300">{error}</div>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

// Run name = basename of the clone path. Falls back to a placeholder
// if the path lacks a meaningful tail (defensive).
function deriveRunName(clonePath: string): string {
  // Cross-platform basename: split on either separator and grab the
  // non-empty tail. Path module on web is overkill for this.
  const parts = clonePath.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? "(unnamed run)";
}
