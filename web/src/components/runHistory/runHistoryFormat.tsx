/** Shared formatters + chips for run history UI. */
import type { AgentRole, Topology } from "../../../../shared/src/topology";

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function roleForRow(preset: string, idx: number, totalAgents: number): string {
  switch (preset) {
    case "blackboard":
      if (idx === 1) return "planner";
      if (idx > totalAgents - 1) return "auditor";
      return "worker";
    case "orchestrator-worker":
      return idx === 1 ? "orchestrator" : "worker";
    case "orchestrator-worker-deep": {
      if (idx === 1) return "orchestrator";
      const remaining = Math.max(0, totalAgents - 1);
      const targetK = Math.max(1, Math.ceil(remaining / 6));
      const maxK = Math.max(1, Math.floor(remaining / 3));
      const k = Math.min(targetK, maxK);
      return idx <= 1 + k ? "mid-lead" : "worker";
    }
    case "map-reduce":
      return idx === 1 ? "reducer" : "mapper";
    case "council":
      return "drafter";
    case "stigmergy":
      return "explorer";
    case "round-robin":
      return "peer";
    case "role-diff":
      return "role-diff";
    case "debate-judge":
      if (idx === 1) return "pro";
      if (idx === 2) return "con";
      if (idx === 3) return "judge";
      return "peer";
    default:
      return idx === 1 ? "planner" : "worker";
  }
}

export function formatDurationCompact(ms: number): string {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}:${pad(h)}:${pad(m)}:${pad(s)}`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  if (m > 0) return `${m}:${pad(s)}`;
  if (s > 0) return `${s}`;
  return "—";
}

export function formatRuntimeMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d} d ${h} h ${m} m ${s} s`;
  if (h > 0) return `${h} h ${m} m ${s} s`;
  if (m > 0) return `${m} m ${s} s`;
  return `${s} s`;
}

const ROLE_LETTER: Record<AgentRole, string> = {
  planner: "P",
  worker: "W",
  auditor: "A",
  orchestrator: "O",
  "mid-lead": "M",
  reducer: "R",
  mapper: "M",
  drafter: "D",
  explorer: "E",
  peer: "·",
  pro: "+",
  con: "−",
  judge: "J",
  "role-diff": "R",
};

export function TopologyChip({ topology }: { topology: Topology | undefined }) {
  if (!topology || topology.agents.length === 0) {
    return <span className="text-ink-400 opacity-50">—</span>;
  }
  const counts = new Map<AgentRole, number>();
  for (const a of topology.agents) {
    counts.set(a.role, (counts.get(a.role) ?? 0) + 1);
  }
  const compact = Array.from(counts.entries())
    .map(([role, n]) => `${n}${ROLE_LETTER[role] ?? "?"}`)
    .join(" · ");
  const tooltip = topology.agents
    .map((a) => `#${a.index} ${a.role}${a.model ? ` (${a.model})` : ""}`)
    .join("\n");
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded border bg-ink-800/60 border-ink-700/60 text-ink-300 font-mono"
      title={tooltip}
    >
      {compact}
    </span>
  );
}

const PRESET_CHIP_STYLES: Record<string, string> = {
  blackboard: "bg-emerald-900/40 border-emerald-700/50 text-emerald-200",
  council: "bg-sky-900/40 border-sky-700/50 text-sky-200",
  "orchestrator-worker": "bg-amber-900/40 border-amber-700/50 text-amber-200",
  "orchestrator-worker-deep": "bg-amber-950/60 border-amber-600/60 text-amber-100",
  "map-reduce": "bg-violet-900/40 border-violet-700/50 text-violet-200",
  "role-diff": "bg-fuchsia-900/40 border-fuchsia-700/50 text-fuchsia-200",
  "debate-judge": "bg-rose-900/40 border-rose-700/50 text-rose-200",
  stigmergy: "bg-teal-900/40 border-teal-700/50 text-teal-200",
  "round-robin": "bg-ink-700 border-ink-600 text-ink-200",
};

export function PresetChip({ preset }: { preset: string }) {
  const cls = PRESET_CHIP_STYLES[preset] ?? "bg-ink-700 border-ink-600 text-ink-200";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wide ${cls}`}>
      {preset}
    </span>
  );
}

export function ResultChip({ reason }: { reason: string }) {
  let cls = "bg-ink-700 border-ink-600 text-ink-300";
  let label = reason;
  if (reason === "completed") {
    cls = "bg-emerald-900/40 border-emerald-700/50 text-emerald-300";
    label = "completed";
  } else if (reason === "user") {
    cls = "bg-ink-800 border-ink-700 text-ink-400";
    label = "stopped";
  } else if (reason === "crash" || reason === "failed") {
    cls = "bg-rose-900/40 border-rose-700/50 text-rose-300";
    label = "crashed";
  } else if (reason.startsWith("cap:")) {
    cls = "bg-amber-900/40 border-amber-700/50 text-amber-300";
    label = reason.replace("cap:", "cap·");
  } else if (reason === "early-stop") {
    cls = "bg-sky-900/40 border-sky-700/50 text-sky-300";
    label = "early-stop";
  } else if (reason === "no-progress") {
    cls = "bg-amber-900/40 border-amber-700/50 text-amber-300";
    label = "no-progress";
  } else if (reason === "partial-progress") {
    cls = "bg-sky-900/40 border-sky-700/50 text-sky-300";
    label = "partial-progress";
  }
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${cls}`}>
      {label}
    </span>
  );
}

export function fmtTimeShort(ts: number): string {
  const d = new Date(ts);
  const FS = " ";
  const padInvis = (n: number): string => (n < 10 ? `${FS}${n}` : `${n}`);
  const date = `${padInvis(d.getMonth() + 1)}/${padInvis(d.getDate())}`;
  let hour = d.getHours();
  const isAM = hour < 12;
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  const time = `${padInvis(hour)}:${padInvis(d.getMinutes())} ${isAM ? "AM" : "PM"}`;
  return `${date} · ${time}`;
}
