// Brain / guard suggestion bubble with optional one-click RECONFIG apply.

import { useEffect, useState } from "react";
import { useSwarm } from "../../state/store";
import { apiFetch } from "../../lib/apiFetch";
import {
  extractReconfig,
  formatReconfigLabel,
} from "../brainChat/chatHelpers";
import type { RunReconfigPatch } from "../brainChat/types";
import { writeDeferredReconfig } from "../../lib/deferredReconfig";

/** How long after a hard terminal phase we still offer Apply (ms). */
const TERMINAL_RECONFIG_GRACE_MS = 90_000;

export function BrainSuggestionBubble({
  text,
  ts,
}: {
  text: string;
  ts: string;
}) {
  const runId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);
  const reconfig = extractReconfig(text) as RunReconfigPatch | null;
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminalSince, setTerminalSince] = useState<number | null>(null);

  // Track when we first observe a hard terminal phase for this run.
  useEffect(() => {
    if (phase === "completed" || phase === "stopped" || phase === "failed") {
      setTerminalSince((prev) => prev ?? Date.now());
    } else if (
      phase === "executing"
      || phase === "planning"
      || phase === "discussing"
      || phase === "stopping"
      || phase === "draining"
      || phase === "paused"
    ) {
      setTerminalSince(null);
    }
  }, [phase]);

  // Strip leading badge prefix for display body.
  const body = text
    .replace(/^\[🧠 Brain Suggestion\]\s*/i, "")
    .replace(/^\[brain suggestion\]\s*/i, "")
    .trim();

  const titleLine = body.split("\n")[0] ?? "Brain suggestion";
  const rest = body.includes("\n") ? body.slice(titleLine.length).trimStart() : "";

  const hardTerminal =
    phase === "completed" || phase === "stopped" || phase === "failed";
  const softTerminal =
    phase === "stopping" || phase === "draining" || phase === "paused";
  const inTerminalGrace =
    hardTerminal
    && terminalSince != null
    && Date.now() - terminalSince < TERMINAL_RECONFIG_GRACE_MS;

  // Allow apply on live work, soft-terminal (stop/drain in flight), and
  // briefly after hard terminal while the run may still be reconfigurable.
  const canApply =
    !!reconfig
    && !!runId
    && !applied
    && phase !== "idle"
    && (softTerminal || inTerminalGrace || !hardTerminal);

  async function applyReconfig() {
    if (!reconfig || !runId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/swarm/reconfig`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, ...reconfig }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data as { error?: string }).error ?? res.statusText;
        // Persist for next start when the run already finished.
        if (res.status === 404 || /no active run/i.test(msg)) {
          writeDeferredReconfig({ runId, patch: reconfig, at: Date.now() });
          throw new Error(
            "Run already finished — saved for next Start (wall-clock/rounds/token).",
          );
        }
        throw new Error(msg);
      }
      setApplied(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-l-2 border-violet-500/70 pl-3 py-1.5 text-xs font-mono">
      <div className="text-violet-300/90 mb-0.5 flex items-center gap-1.5 flex-wrap">
        <span className="inline-block px-1 py-0 text-[9px] uppercase tracking-wider rounded bg-violet-900/50 text-violet-200">
          brain
        </span>
        <span className="text-ink-500">{ts}</span>
      </div>
      <div className="text-violet-100/90 font-semibold mb-0.5">{titleLine}</div>
      {rest ? (
        <div className="whitespace-pre-wrap text-ink-300/90 text-[11px] leading-relaxed">{rest}</div>
      ) : null}
      {reconfig ? (
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-sky-300/80">
            RECONFIG: {formatReconfigLabel(reconfig)}
          </span>
          {canApply ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void applyReconfig()}
              className="text-[10px] px-1.5 py-0.5 rounded border border-sky-700/60 bg-sky-950/40 text-sky-200 hover:bg-sky-900/50 disabled:opacity-50"
            >
              {busy
                ? "applying…"
                : hardTerminal
                  ? "Apply (grace)"
                  : "Apply limits"}
            </button>
          ) : null}
          {applied ? (
            <span className="text-[10px] text-emerald-400/90">applied</span>
          ) : null}
          {error ? (
            <span className="text-[10px] text-rose-400/90">{error}</span>
          ) : null}
          {hardTerminal && !canApply && !applied ? (
            <span className="text-[10px] text-ink-500">
              reconfig window closed (run finished)
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
