import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSwarm } from "../state/store";
import { isActiveSwarmPhase } from "../lib/swarmPhase";
import type { SwarmControlAdvice } from "../state/store";

const KIND_LABEL: Record<SwarmControlAdvice["kind"], string> = {
  stall_gate: "stall gate",
  tool_coach: "tool coach",
};

const ACTION_STYLE: Record<string, string> = {
  backoff: "text-amber-300",
  retry: "text-sky-300",
  stop: "text-rose-300",
};

function adviceKey(a: SwarmControlAdvice): string {
  return `${a.ts}|${a.kind}|${a.agentId ?? ""}|${a.tool ?? ""}|${a.action ?? ""}`;
}

/** Strip tool-XML / pseudo-tags and collapse whitespace for readable cards. */
function formatControlText(raw: string | undefined): string {
  if (!raw) return "";
  let t = raw
    .replace(/<\/?(?:tool_use|function_call|function|invoke|parameter|arguments|server_name|tool_name)[^>]*>/gi, " ")
    .replace(/<\/?[a-zA-Z_][\w:-]*\b[^>]*>/g, " ")
    .replace(/&lt;|&gt;|&amp;/g, (m) => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&" }[m] ?? m))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (t.length > 1200) t = `${t.slice(0, 1200)}…`;
  return t || "(empty)";
}

export function SwarmControlPanel() {
  const runId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);
  const advice = useSwarm((s) => s.controlAdvice);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const live = isActiveSwarmPhase(phase);
  const recent = advice.slice(-12).reverse();

  const syncPanelPosition = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: Math.max(8, rect.left - 120) });
  };

  const closePanel = () => setOpen(false);

  const openPanel = () => {
    syncPanelPosition();
    setOpen(true);
  };

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

  if (!runId) return null;

  const stallCount = advice.filter((a) => a.kind === "stall_gate").length;
  const coachCount = advice.filter((a) => a.kind === "tool_coach").length;

  const chipStyle =
    advice.length === 0
      ? "bg-ink-800/60 text-ink-500 border-ink-700/50"
      : live
        ? "bg-cyan-900/35 text-cyan-300 border-cyan-800/50"
        : "bg-ink-800/80 text-ink-400 border-ink-700/50";

  const chipLabel =
    advice.length === 0
      ? "control idle"
      : `control ${stallCount}g/${coachCount}c`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closePanel() : openPanel())}
        title="Swarm control center — stall gates and tool-coach hints"
        className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide ${chipStyle}`}
      >
        {chipLabel}
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              className="fixed z-[9999] w-[min(440px,calc(100vw-16px))] max-h-[min(420px,60vh)] overflow-y-auto rounded-lg border border-ink-600 bg-ink-950 shadow-2xl shadow-black/60 p-3 text-[11px] text-ink-100"
              style={{ top: pos.top, left: pos.left, backgroundColor: "#0b1220" }}
            >
              <div className="flex items-center justify-between mb-2 gap-2">
                <span className="text-ink-50 font-semibold">Swarm control</span>
                <span className="text-ink-400 text-[10px] shrink-0">
                  {live ? "live" : "historical"} · {advice.length} event{advice.length === 1 ? "" : "s"}
                </span>
              </div>
              {recent.length === 0 ? (
                <p className="text-ink-400 leading-relaxed">
                  No control advice yet. Stall gates and tool coaches emit here when rules or bounded AI intervene.
                </p>
              ) : (
                <ul className="space-y-2">
                  {recent.map((a) => (
                    <li
                      key={adviceKey(a)}
                      className="rounded border border-ink-700 bg-ink-900 px-2.5 py-2 shadow-inner"
                    >
                      <div className="flex flex-wrap items-center gap-1.5 mb-1">
                        <span className="text-[10px] uppercase tracking-wide text-cyan-300 font-semibold">
                          {KIND_LABEL[a.kind]}
                        </span>
                        {a.source ? (
                          <span className="text-[10px] text-ink-400">via {a.source}</span>
                        ) : null}
                        {a.action ? (
                          <span className={`text-[10px] font-semibold uppercase ${ACTION_STYLE[a.action] ?? "text-ink-200"}`}>
                            {a.action}
                          </span>
                        ) : null}
                        {a.tool ? (
                          <span className="text-[10px] text-ink-400 font-mono">{a.tool}</span>
                        ) : null}
                        <span className="text-[10px] text-ink-500 ml-auto tabular-nums">
                          {new Date(a.ts).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-ink-100 leading-snug whitespace-pre-wrap break-words max-h-28 overflow-y-auto">
                        {formatControlText(a.rationale)}
                      </p>
                      {a.plannerHint ? (
                        <p className="mt-1.5 text-ink-300 text-[10px] leading-snug border-t border-ink-700 pt-1.5 whitespace-pre-wrap break-words max-h-20 overflow-y-auto">
                          <span className="text-ink-400">planner:</span> {formatControlText(a.plannerHint)}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}