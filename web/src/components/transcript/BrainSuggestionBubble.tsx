// Brain / guard suggestion bubble with optional one-click RECONFIG apply.

import { useState } from "react";
import { useSwarm } from "../../state/store";
import { apiFetch } from "../../lib/apiFetch";
import {
  extractReconfig,
  formatReconfigLabel,
} from "../brainChat/chatHelpers";
import type { RunReconfigPatch } from "../brainChat/types";

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

  // Strip leading badge prefix for display body.
  const body = text
    .replace(/^\[🧠 Brain Suggestion\]\s*/i, "")
    .replace(/^\[brain suggestion\]\s*/i, "")
    .trim();

  const titleLine = body.split("\n")[0] ?? "Brain suggestion";
  const rest = body.includes("\n") ? body.slice(titleLine.length).trimStart() : "";

  const canApply =
    !!reconfig &&
    !!runId &&
    !applied &&
    phase !== "idle" &&
    phase !== "completed" &&
    phase !== "stopped" &&
    phase !== "failed";

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
      if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
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
              {busy ? "applying…" : "Apply limits"}
            </button>
          ) : null}
          {applied ? (
            <span className="text-[10px] text-emerald-400/90">applied</span>
          ) : null}
          {error ? (
            <span className="text-[10px] text-rose-400/90">{error}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
