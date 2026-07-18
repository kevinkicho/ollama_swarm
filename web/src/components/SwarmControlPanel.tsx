import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSwarm } from "../state/store";
import { isActiveSwarmPhase } from "../lib/swarmPhase";
import type { DeliberationAdvice, SwarmControlAdvice } from "../state/swarmStoreTypes";
import { computeResilienceRollup } from "@ollama-swarm/shared/swarmControl/controlAdvice";

const KIND_LABEL: Record<SwarmControlAdvice["kind"], string> = {
  stall_gate: "stall recovery",
  tool_coach: "thrash brake",
  brain_os: "Brain OS",
};

const ACTION_STYLE: Record<string, string> = {
  backoff: "text-amber-300",
  retry: "text-sky-300",
  stop: "text-rose-300",
};

const VERDICT_STYLE: Record<string, string> = {
  approve: "text-emerald-300",
  deny: "text-rose-300",
  validate: "text-sky-300",
  challenge: "text-amber-300",
  abstain: "text-ink-400",
  claim: "text-ink-300",
};

function adviceKey(a: SwarmControlAdvice): string {
  return `${a.ts}|${a.kind}|${a.agentId ?? ""}|${a.tool ?? ""}|${a.action ?? ""}|${a.rationale.slice(0, 24)}`;
}

function delibKey(d: DeliberationAdvice, i: number): string {
  return d.id ?? `${d.ts}|${d.layer}|${d.verdict}|${d.subject}|${i}`;
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

/**
 * Run resilience panel (formerly labeled "Governance").
 * Surfaces the live control plane that keeps runs durable under thrash,
 * stalls, bad commits, and tool loops — not abstract policy bureaucracy.
 */
export function SwarmControlPanel() {
  const runId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);
  const advice = useSwarm((s) => s.controlAdvice);
  const deliberation = useSwarm((s) => s.deliberation);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [tab, setTab] = useState<"control" | "deliberation">("control");

  const live = isActiveSwarmPhase(phase);
  const recent = advice.slice(-12).reverse();
  const recentDelib = deliberation.slice(-16).reverse();

  const rollup = computeResilienceRollup(advice, deliberation);

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

  const totalEvents = advice.length + deliberation.length;
  const scoreColor =
    rollup.score >= 80
      ? "text-emerald-300"
      : rollup.score >= 55
        ? "text-sky-300"
        : rollup.score >= 35
          ? "text-amber-300"
          : "text-rose-300";

  const chipStyle =
    totalEvents === 0
      ? "bg-ink-800/60 text-ink-500 border-ink-700/50"
      : live
        ? rollup.score < 45
          ? "bg-amber-900/40 text-amber-200 border-amber-800/50"
          : "bg-cyan-900/35 text-cyan-300 border-cyan-800/50"
        : "bg-ink-800/80 text-ink-400 border-ink-700/50";

  const chipLabel =
    totalEvents === 0
      ? "resilience idle"
      : `res ${rollup.score} · ${rollup.stallGates}s/${rollup.toolCoaches}t/${rollup.brainOsEvents}os`;

  const tooltip = [
    "Run resilience — keeps the swarm durable under failure.",
    "• Stall recovery: backoff/retry/stop when the board stops advancing",
    "• Thrash brakes: tool-coach after repeated tool failures",
    "• Quality gates: auditor approve/deny commits (bad patches don't ship)",
    "• Brain OS: recruits helpers on apply_miss / parse_fail / tool_block / stuck progress",
    "Not abstract policy — this is the run's performance & recovery control plane.",
  ].join("\n");

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closePanel() : openPanel())}
        title={tooltip}
        className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide ${chipStyle}`}
      >
        {chipLabel}
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              className="fixed z-[9999] w-[min(480px,calc(100vw-16px))] max-h-[min(460px,70vh)] overflow-y-auto rounded-lg border border-ink-600 bg-ink-950 shadow-2xl shadow-black/60 p-3 text-[11px] text-ink-100"
              style={{ top: pos.top, left: pos.left, backgroundColor: "#0b1220" }}
            >
              <div className="flex items-center justify-between mb-1 gap-2">
                <span className="text-ink-50 font-semibold">Run resilience</span>
                <span className="text-ink-400 text-[10px] shrink-0">
                  {live ? "live" : "historical"}
                </span>
              </div>
              <p className="text-ink-400 text-[10px] leading-snug mb-2">
                Performance under stress: thrash brakes, stall recovery, commit quality gates,
                and Brain OS helpers — so runs stay durable instead of spinning or shipping junk.
              </p>

              {/* Resilience score strip */}
              <div className="grid grid-cols-4 gap-1.5 mb-2 text-[10px]">
                <div className="rounded border border-ink-700 bg-ink-900/80 px-1.5 py-1 text-center">
                  <div className={`font-semibold tabular-nums ${scoreColor}`}>{rollup.score}</div>
                  <div className="text-ink-500 uppercase tracking-wide">{rollup.label}</div>
                </div>
                <div className="rounded border border-ink-700 bg-ink-900/80 px-1.5 py-1 text-center">
                  <div className="font-semibold tabular-nums text-amber-200">{rollup.stallGates}</div>
                  <div className="text-ink-500">stalls</div>
                </div>
                <div className="rounded border border-ink-700 bg-ink-900/80 px-1.5 py-1 text-center">
                  <div className="font-semibold tabular-nums text-sky-200">{rollup.toolCoaches}</div>
                  <div className="text-ink-500">brakes</div>
                </div>
                <div className="rounded border border-ink-700 bg-ink-900/80 px-1.5 py-1 text-center">
                  <div className="font-semibold tabular-nums text-violet-200">{rollup.brainOsEvents}</div>
                  <div className="text-ink-500">Brain OS</div>
                </div>
              </div>

              <div className="flex gap-1 mb-2">
                <button
                  type="button"
                  onClick={() => setTab("control")}
                  className={`px-2 py-0.5 rounded text-[10px] uppercase font-semibold border ${
                    tab === "control"
                      ? "border-cyan-700 bg-cyan-950/50 text-cyan-200"
                      : "border-ink-700 text-ink-400 hover:text-ink-200"
                  }`}
                >
                  recovery ({advice.length})
                </button>
                <button
                  type="button"
                  onClick={() => setTab("deliberation")}
                  className={`px-2 py-0.5 rounded text-[10px] uppercase font-semibold border ${
                    tab === "deliberation"
                      ? "border-violet-700 bg-violet-950/40 text-violet-200"
                      : "border-ink-700 text-ink-400 hover:text-ink-200"
                  }`}
                >
                  quality gates ({deliberation.length})
                </button>
              </div>

              {tab === "control" ? (
                recent.length === 0 ? (
                  <p className="text-ink-400 leading-relaxed">
                    No recovery events yet. When agents thrash tools, the board stalls, or Brain OS
                    recruits helpers, interventions show here — reducing wasted tokens and avoiding
                    dead-end loops.
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
                            {KIND_LABEL[a.kind] ?? a.kind}
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
                          {a.conflictKind ? (
                            <span className="text-[10px] text-violet-300 font-mono">{a.conflictKind}</span>
                          ) : null}
                          {a.status ? (
                            <span className="text-[10px] text-ink-300">{a.status}</span>
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
                            <span className="text-ink-400">next action:</span> {formatControlText(a.plannerHint)}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )
              ) : recentDelib.length === 0 ? (
                <p className="text-ink-400 leading-relaxed">
                  No quality-gate transactions yet. Auditor approve/deny on commits, peer challenges,
                  and control votes land here and in{" "}
                  <span className="font-mono text-ink-300">logs/&lt;runId&gt;/deliberation.jsonl</span>
                  {" "}— blocking fragile patches from becoming durable git history.
                </p>
              ) : (
                <ul className="space-y-2">
                  {recentDelib.map((d, i) => (
                    <li
                      key={delibKey(d, i)}
                      className="rounded border border-ink-700 bg-ink-900 px-2.5 py-2 shadow-inner"
                    >
                      <div className="flex flex-wrap items-center gap-1.5 mb-1">
                        <span className="text-[10px] uppercase tracking-wide text-violet-300 font-semibold">
                          {d.layer}
                        </span>
                        <span
                          className={`text-[10px] font-semibold uppercase ${
                            VERDICT_STYLE[d.verdict] ?? "text-ink-200"
                          }`}
                        >
                          {d.verdict}
                        </span>
                        {d.proposer ? (
                          <span className="text-[10px] text-ink-400 font-mono">{d.proposer}</span>
                        ) : null}
                        {d.validator ? (
                          <span className="text-[10px] text-ink-500">→ {d.validator}</span>
                        ) : null}
                        <span className="text-[10px] text-ink-500 ml-auto tabular-nums">
                          {new Date(d.ts).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-ink-100 leading-snug break-words">
                        {d.subject}
                      </p>
                      {(d.validationReason || d.claim) ? (
                        <p className="mt-1 text-ink-300 text-[10px] leading-snug whitespace-pre-wrap break-words max-h-20 overflow-y-auto">
                          {formatControlText(d.validationReason || d.claim)}
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
