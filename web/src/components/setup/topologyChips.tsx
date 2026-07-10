/**
 * Topology grid chips, color picker, and bulk-apply control.
 */

import { useState, type ReactNode } from "react";
import {
  type AgentColor,
  type AgentRole,
  AGENT_COLORS,
} from "../../../../shared/src/topology";

const COLOR_SWATCH_CLASS: Record<AgentColor, string> = {
  emerald: "bg-emerald-500",
  sky: "bg-sky-500",
  amber: "bg-amber-500",
  violet: "bg-violet-500",
  rose: "bg-rose-500",
  teal: "bg-teal-500",
  fuchsia: "bg-fuchsia-500",
  lime: "bg-lime-500",
};

const ROLE_CHIP_STYLES: Record<AgentRole, string> = {
  planner: "bg-emerald-900/40 border-emerald-700/50 text-emerald-200",
  auditor: "bg-violet-900/40 border-violet-700/50 text-violet-200",
  orchestrator: "bg-amber-900/40 border-amber-700/50 text-amber-200",
  "mid-lead": "bg-amber-950/60 border-amber-600/60 text-amber-100",
  reducer: "bg-violet-900/40 border-violet-700/50 text-violet-200",
  judge: "bg-rose-900/40 border-rose-700/50 text-rose-200",
  pro: "bg-emerald-900/40 border-emerald-700/50 text-emerald-200",
  con: "bg-rose-900/40 border-rose-700/50 text-rose-200",
  worker: "bg-ink-700 border-ink-600 text-ink-200",
  mapper: "bg-violet-900/30 border-violet-700/40 text-violet-200",
  drafter: "bg-sky-900/40 border-sky-700/50 text-sky-200",
  explorer: "bg-teal-900/40 border-teal-700/50 text-teal-200",
  peer: "bg-ink-700 border-ink-600 text-ink-300",
  "role-diff": "bg-fuchsia-900/40 border-fuchsia-700/50 text-fuchsia-200",
};

export function ColorPicker({
  value,
  onChange,
}: {
  value: AgentColor | undefined;
  onChange: (c: AgentColor | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {AGENT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(value === c ? undefined : c)}
          className={`w-4 h-4 rounded-full ${COLOR_SWATCH_CLASS[c]} ${
            value === c
              ? "ring-2 ring-ink-100 ring-offset-1 ring-offset-ink-900"
              : "opacity-60 hover:opacity-100"
          } transition`}
          title={value === c ? `${c} (click to clear)` : c}
          aria-label={`Pick color ${c}`}
        />
      ))}
    </div>
  );
}

export function RoleChip({
  role,
  structural,
}: {
  role: AgentRole;
  structural: boolean;
}) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wide ${ROLE_CHIP_STYLES[role]}`}
      title={
        structural
          ? "Structural — required by this preset"
          : "Flexible — you can scale this role"
      }
    >
      {structural ? "🔒 " : ""}
      {role}
    </span>
  );
}

/** Header-row bulk apply — arrow only; row dropdowns stay full-width. */
export function ApplyAllSelect({
  ariaLabel,
  onApply,
  children,
}: {
  ariaLabel: string;
  onApply: (value: string) => void;
  children: ReactNode;
}) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <div
      className="relative inline-flex items-center justify-center w-6 h-6 shrink-0 group"
      title="Apply to all agents in this column"
    >
      <select
        key={resetKey}
        defaultValue=""
        aria-label={ariaLabel}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          onApply(v);
          setResetKey((k) => k + 1);
        }}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      >
        <option value="" />
        {children}
      </select>
      <span
        className="pointer-events-none inline-flex items-center justify-center w-6 h-6 rounded border border-ink-600 bg-ink-900/80 text-[10px] text-ink-400 group-hover:text-ink-200 group-hover:border-ink-500"
        aria-hidden
      >
        ▾
      </span>
    </div>
  );
}

export function nextAddableRole(preset: string): AgentRole | null {
  switch (preset) {
    case "blackboard":
      return "worker";
    case "map-reduce":
      return "mapper";
    case "council":
      return "drafter";
    case "stigmergy":
      return "explorer";
    case "round-robin":
      return "peer";
    case "orchestrator-worker":
    case "orchestrator-worker-deep":
      return "worker";
    case "role-diff":
      return "role-diff";
    case "debate-judge":
      return null;
    default:
      return "worker";
  }
}
