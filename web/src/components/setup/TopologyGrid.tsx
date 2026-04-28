// Phase 1c of the topology refactor (#243): grid that replaces the
// `Agents` number input. Rows are agent specs; +/− scale the count;
// structural rows (planner/auditor/orchestrator/judge…) lock their
// `−` button so users can't accidentally delete the role the preset
// requires. The grid is the source of truth — SetupForm reads its
// `topology` state and POSTs it to /api/swarm/start.
//
// What's NOT here in Phase 1:
//   - per-agent prompt addendum / temperature / tag / color (Phase 2)
//   - saved-topology library (Phase 3)
//   - mirroring into AgentPanel + History (Phase 4)
// Each later phase adds columns or adjacent UI without restructuring.

import { useEffect, useMemo, useState } from "react";
import {
  type AgentColor,
  type AgentRole,
  type AgentSpec,
  type Topology,
  AGENT_COLORS,
  defaultRoleForIndex,
  isRoleStructural,
  synthesizeTopology,
} from "../../../../shared/src/topology";

// Phase 2 of #243: tailwind color name → swatch CSS for the per-row
// color picker. Single source of truth — AgentPanel's color border
// uses the same palette so picks are consistent across the UI.
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

// Phase 3 of #243: saved-topology library + per-preset last-used
// persistence in localStorage. Survives dev-server restarts so the
// user's preferred shape comes back automatically.
//
// Schema:
//   ollama-swarm:topology:last-used:{preset} → Topology (last shape
//     used on this preset, written on every grid change)
//   ollama-swarm:topology:saved → SavedTopology[] (named entries the
//     user explicitly saved). Capped at 32 entries; oldest evicted
//     when full.

const LAST_USED_PREFIX = "ollama-swarm:topology:last-used:";
const SAVED_KEY = "ollama-swarm:topology:saved";
const SAVED_MAX = 32;

interface SavedTopology {
  name: string;
  preset: string;
  topology: Topology;
  ts: number;
}

function readLastUsed(presetId: string): Topology | null {
  try {
    const raw = localStorage.getItem(`${LAST_USED_PREFIX}${presetId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.agents)) return parsed as Topology;
  } catch {
    // localStorage disabled / parse error — silent fallback to defaults.
  }
  return null;
}
function writeLastUsed(presetId: string, t: Topology): void {
  try {
    localStorage.setItem(`${LAST_USED_PREFIX}${presetId}`, JSON.stringify(t));
  } catch {
    // quota / disabled — silent.
  }
}
function readSavedList(): SavedTopology[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as SavedTopology[];
  } catch {
    // ignore
  }
  return [];
}
function writeSavedList(list: SavedTopology[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, SAVED_MAX)));
  } catch {
    // ignore
  }
}

interface TopologyGridProps {
  preset: {
    id: string;
    min: number;
    max: number;
  };
  topology: Topology;
  setTopology: (t: Topology) => void;
  // Top-level default model — used as placeholder for per-row Model
  // inputs so the user sees what each agent will fall back to.
  defaultModel: string;
}

// Roles that CAN be added incrementally (the user can add another one
// of these). Today this is just "worker" for blackboard, "mapper" for
// map-reduce, "drafter" for council, "explorer" for stigmergy,
// "peer" for round-robin. Other roles are structural (planner, judge,
// reducer, orchestrator) and the preset's defaults always include the
// right number — never user-added.
function nextAddableRole(preset: string): AgentRole | null {
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
      // Fixed at 3 — never addable.
      return null;
    default:
      return "worker";
  }
}

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

function ColorPicker({
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
            value === c ? "ring-2 ring-ink-100 ring-offset-1 ring-offset-ink-900" : "opacity-60 hover:opacity-100"
          } transition`}
          title={value === c ? `${c} (click to clear)` : c}
          aria-label={`Pick color ${c}`}
        />
      ))}
    </div>
  );
}

function RoleChip({ role, structural }: { role: AgentRole; structural: boolean }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wide ${ROLE_CHIP_STYLES[role]}`}
      title={structural ? "Structural — required by this preset" : "Flexible — you can scale this role"}
    >
      {structural ? "🔒 " : ""}{role}
    </span>
  );
}

export function TopologyGrid({ preset, topology, setTopology, defaultModel }: TopologyGridProps) {
  const total = topology.agents.length;
  const atMax = total >= preset.max;
  const atMin = total <= preset.min;
  const addableRole = nextAddableRole(preset.id);
  const canAdd = !atMax && addableRole !== null;

  // Phase 3: auto-save last-used topology on every change so the
  // user's preferred shape survives dev-server restarts and the
  // next "switch back to this preset" recovers their setup.
  useEffect(() => {
    writeLastUsed(preset.id, topology);
  }, [preset.id, topology]);

  // Saved-list state — re-read on every render of the library
  // dropdown so manual edits to localStorage in another tab show up.
  const [savedList, setSavedList] = useState<SavedTopology[]>(() => readSavedList());
  // Filtered saved entries that match the current preset (only those
  // are loadable into this grid — cross-preset shapes wouldn't make
  // sense). Computed lazily so render is cheap.
  const presetSaved = useMemo(
    () => savedList.filter((s) => s.preset === preset.id),
    [savedList, preset.id],
  );
  const [showLibrary, setShowLibrary] = useState(false);
  const [pendingName, setPendingName] = useState("");

  // Phase 2 of #243: column-toggle state. Default-off so the grid
  // stays scannable for users who don't need per-agent specialization.
  // Toggling on reveals the column for every row at once. State lives
  // in localStorage so the user's preference survives reloads.
  const [showColor, setShowColor] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem("ollama-swarm:topology:col:color") === "on",
  );
  const [showTag, setShowTag] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem("ollama-swarm:topology:col:tag") === "on",
  );
  const [showTemp, setShowTemp] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem("ollama-swarm:topology:col:temp") === "on",
  );
  const [showPrompt, setShowPrompt] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem("ollama-swarm:topology:col:prompt") === "on",
  );
  const persistColToggle = (key: string, on: boolean) => {
    try {
      localStorage.setItem(`ollama-swarm:topology:col:${key}`, on ? "on" : "off");
    } catch {
      // ignore
    }
  };

  const onSaveAs = () => {
    const name = pendingName.trim();
    if (name.length === 0) return;
    const next: SavedTopology = {
      name,
      preset: preset.id,
      topology,
      ts: Date.now(),
    };
    // De-dupe by name within preset (overwrite if exists).
    const filtered = savedList.filter(
      (s) => !(s.preset === preset.id && s.name === name),
    );
    const updated = [next, ...filtered].slice(0, SAVED_MAX);
    writeSavedList(updated);
    setSavedList(updated);
    setPendingName("");
  };
  const onLoadSaved = (entry: SavedTopology) => {
    setTopology(entry.topology);
    setShowLibrary(false);
  };
  const onDeleteSaved = (entry: SavedTopology) => {
    const updated = savedList.filter(
      (s) => !(s.preset === entry.preset && s.name === entry.name && s.ts === entry.ts),
    );
    writeSavedList(updated);
    setSavedList(updated);
  };
  const onResetToDefaults = () => {
    setTopology(synthesizeTopology(preset.id, preset.min === preset.max ? preset.min : (topology.agents.length || preset.min)));
  };

  const renumber = (agents: AgentSpec[]): AgentSpec[] => {
    // After +/-, re-derive role + index for every row so the auditor
    // stays at the bottom (blackboard) and mid-lead/worker boundaries
    // shift correctly (orchestrator-worker-deep) when count changes.
    const totalAfter = agents.length;
    return agents.map((_a, i) => {
      const idx = i + 1;
      const role = defaultRoleForIndex(preset.id, idx, totalAfter);
      // Preserve the user's per-row model if they set one and the role
      // hasn't changed; otherwise reset to undefined (falls back to
      // top-level defaultModel).
      const prior = i < agents.length ? agents[i] : undefined;
      const keptModel = prior && prior.role === role ? prior.model : undefined;
      return {
        index: idx,
        role,
        model: keptModel,
        removable: !isRoleStructural(preset.id, role),
      };
    });
  };

  const onAdd = () => {
    if (!canAdd || addableRole === null) return;
    // Insert before the auditor row for blackboard (auditor stays at
    // the bottom). For other presets the new row goes at the end.
    let nextAgents: AgentSpec[];
    if (preset.id === "blackboard") {
      const auditorIdx = topology.agents.findIndex((a) => a.role === "auditor");
      const insertAt = auditorIdx >= 0 ? auditorIdx : topology.agents.length;
      nextAgents = [
        ...topology.agents.slice(0, insertAt),
        { index: insertAt + 1, role: addableRole, removable: true },
        ...topology.agents.slice(insertAt),
      ];
    } else {
      nextAgents = [
        ...topology.agents,
        { index: total + 1, role: addableRole, removable: true },
      ];
    }
    setTopology({ agents: renumber(nextAgents) });
  };

  const onRemove = (index: number) => {
    if (atMin) return;
    const agent = topology.agents.find((a) => a.index === index);
    if (!agent || !agent.removable) return;
    const nextAgents = topology.agents.filter((a) => a.index !== index);
    setTopology({ agents: renumber(nextAgents) });
  };

  const onModelChange = (index: number, value: string) => {
    const trimmed = value.trim();
    setTopology({
      agents: topology.agents.map((a) =>
        a.index === index
          ? { ...a, model: trimmed.length > 0 ? trimmed : undefined }
          : a,
      ),
    });
  };
  // Phase 2 of #243: per-row mutators for the new optional fields.
  const onTagChange = (index: number, value: string) => {
    const trimmed = value.trim();
    setTopology({
      agents: topology.agents.map((a) =>
        a.index === index
          ? { ...a, tag: trimmed.length > 0 ? trimmed : undefined }
          : a,
      ),
    });
  };
  const onColorChange = (index: number, color: AgentColor | undefined) => {
    setTopology({
      agents: topology.agents.map((a) =>
        a.index === index ? { ...a, color } : a,
      ),
    });
  };
  const onTempChange = (index: number, value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setTopology({
        agents: topology.agents.map((a) =>
          a.index === index ? { ...a, temperature: undefined } : a,
        ),
      });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || n > 2) return;
    setTopology({
      agents: topology.agents.map((a) =>
        a.index === index ? { ...a, temperature: n } : a,
      ),
    });
  };
  const onPromptChange = (index: number, value: string) => {
    const trimmed = value.trim();
    setTopology({
      agents: topology.agents.map((a) =>
        a.index === index
          ? { ...a, promptAddendum: trimmed.length > 0 ? trimmed : undefined }
          : a,
      ),
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-xs uppercase tracking-wide text-ink-400">
          Topology
          <span className="ml-2 text-ink-500 normal-case">
            {total} {total === 1 ? "agent" : "agents"} · min {preset.min} · max {preset.max}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
          {/* Phase 2 of #243: column-toggle pills. Default-off so the
              grid stays compact for casual users; power users opt in
              to the columns they need. Each toggle persists its state. */}
          {[
            { key: "color", label: "Color", val: showColor, setter: setShowColor, hint: "Per-row color badge for AgentPanel cards." },
            { key: "tag", label: "Tag", val: showTag, setter: setShowTag, hint: "Specialization label (e.g. 'tests-expert')." },
            { key: "temp", label: "Temp", val: showTemp, setter: setShowTemp, hint: "Per-agent sampling temperature override (0-2)." },
            { key: "prompt", label: "Prompt+", val: showPrompt, setter: setShowPrompt, hint: "Per-agent system-prompt addendum (max 1000 chars)." },
          ].map(({ key, label, val, setter, hint }) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setter((v) => {
                  const next = !v;
                  persistColToggle(key, next);
                  return next;
                });
              }}
              className={`px-1.5 py-0.5 rounded border transition ${
                val
                  ? "bg-ink-700 text-ink-100 border-ink-600"
                  : "bg-ink-900 text-ink-500 border-ink-800 hover:text-ink-300 hover:bg-ink-800"
              }`}
              title={`${val ? "Hide" : "Show"} the ${label} column. ${hint}`}
            >
              {val ? "✓" : "+"} {label}
            </button>
          ))}
          {/* Phase 3 of #243: library — load / save / reset. Per-preset
              last-used auto-restores; saved entries are explicit
              named snapshots the user can curate. */}
          <button
            type="button"
            onClick={() => setShowLibrary((v) => !v)}
            className="px-2 py-0.5 rounded bg-ink-800 hover:bg-ink-700 text-ink-300 hover:text-ink-100 border border-ink-700 transition"
            title="Open the saved-topology library for this preset"
          >
            {showLibrary ? "▾" : "▸"} Library
            {presetSaved.length > 0 ? (
              <span className="ml-1 text-ink-500">({presetSaved.length})</span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={onResetToDefaults}
            className="px-2 py-0.5 rounded bg-ink-800 hover:bg-ink-700 text-ink-300 hover:text-ink-100 border border-ink-700 transition"
            title="Reset the grid to this preset's recommended defaults (drops your customizations)"
          >
            ↺ Reset
          </button>
          {preset.min === preset.max ? (
            <span className="text-ink-500 italic">Fixed for this preset</span>
          ) : null}
        </div>
      </div>
      {showLibrary ? (
        <div className="rounded border border-ink-700 bg-ink-900/40 p-2 space-y-2 text-[11px]">
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={pendingName}
              onChange={(e) => setPendingName(e.target.value.slice(0, 60))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSaveAs();
                }
              }}
              placeholder="Save current as… (e.g. 'my blackboard 7')"
              className="flex-1 bg-ink-950/60 border border-ink-700 rounded px-2 py-1 text-[11px] text-ink-200 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
            />
            <button
              type="button"
              onClick={onSaveAs}
              disabled={pendingName.trim().length === 0}
              className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-ink-700 disabled:text-ink-500 disabled:cursor-not-allowed text-white text-[11px] border border-emerald-600 transition"
              title="Save the current grid under this name (per-preset)"
            >
              + save
            </button>
          </div>
          {presetSaved.length === 0 ? (
            <div className="text-ink-500 italic px-1">
              No saved topologies for {preset.id} yet. Save the current grid above.
              {/* The last-used auto-save is invisible — it just makes
                  switching back to this preset restore your last shape. */}
            </div>
          ) : (
            <div className="space-y-1">
              {presetSaved.map((s) => (
                <div
                  key={`${s.name}-${s.ts}`}
                  className="flex items-center justify-between gap-2 rounded border border-ink-800/60 bg-ink-950/40 px-2 py-1"
                >
                  <button
                    type="button"
                    onClick={() => onLoadSaved(s)}
                    className="flex-1 text-left text-ink-200 hover:text-ink-100 truncate"
                    title={`Load "${s.name}" — ${s.topology.agents.length} agents · saved ${new Date(s.ts).toLocaleString()}`}
                  >
                    <span className="text-ink-300 font-medium">{s.name}</span>
                    <span className="ml-2 text-ink-500 text-[10px] font-mono">
                      {s.topology.agents.length}A · {new Date(s.ts).toLocaleDateString()}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteSaved(s)}
                    className="text-ink-500 hover:text-rose-300 px-1"
                    title="Delete this saved entry"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
      <div className="rounded border border-ink-700 bg-ink-900/60 overflow-hidden">
        <table className="w-full text-[11px]">
          <thead className="bg-ink-800/60 text-[10px] uppercase tracking-wider text-ink-500">
            <tr>
              <th className="px-2 py-1.5 text-left w-10">#</th>
              {showColor ? <th className="px-2 py-1.5 text-left w-20">Color</th> : null}
              <th className="px-2 py-1.5 text-left">Role</th>
              {showTag ? <th className="px-2 py-1.5 text-left">Tag</th> : null}
              <th className="px-2 py-1.5 text-left">Model override</th>
              {showTemp ? <th className="px-2 py-1.5 text-left w-20">Temp</th> : null}
              {showPrompt ? <th className="px-2 py-1.5 text-left">Prompt+</th> : null}
              <th className="px-2 py-1.5 text-right w-12">Action</th>
            </tr>
          </thead>
          <tbody>
            {topology.agents.map((a) => (
              <tr key={a.index} className="border-t border-ink-800/60">
                <td className="px-2 py-1.5 text-ink-400 font-mono">{a.index}</td>
                {showColor ? (
                  <td className="px-2 py-1.5">
                    <ColorPicker
                      value={a.color}
                      onChange={(c) => onColorChange(a.index, c)}
                    />
                  </td>
                ) : null}
                <td className="px-2 py-1.5">
                  <RoleChip role={a.role} structural={!a.removable} />
                </td>
                {showTag ? (
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={a.tag ?? ""}
                      onChange={(e) => onTagChange(a.index, e.target.value)}
                      placeholder="(none)"
                      maxLength={40}
                      className="w-full bg-ink-950/60 border border-ink-700 rounded px-2 py-0.5 text-[11px] text-ink-200 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
                    />
                  </td>
                ) : null}
                <td className="px-2 py-1.5">
                  <input
                    type="text"
                    value={a.model ?? ""}
                    onChange={(e) => onModelChange(a.index, e.target.value)}
                    placeholder={defaultModel || "(use default)"}
                    className="w-full bg-ink-950/60 border border-ink-700 rounded px-2 py-0.5 text-[11px] font-mono text-ink-200 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
                  />
                </td>
                {showTemp ? (
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      step="0.1"
                      min={0}
                      max={2}
                      value={a.temperature !== undefined ? String(a.temperature) : ""}
                      onChange={(e) => onTempChange(a.index, e.target.value)}
                      placeholder="—"
                      className="w-full bg-ink-950/60 border border-ink-700 rounded px-2 py-0.5 text-[11px] font-mono text-ink-200 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
                    />
                  </td>
                ) : null}
                {showPrompt ? (
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={a.promptAddendum ?? ""}
                      onChange={(e) => onPromptChange(a.index, e.target.value)}
                      placeholder="(none — appends to system prompt)"
                      maxLength={1000}
                      className="w-full bg-ink-950/60 border border-ink-700 rounded px-2 py-0.5 text-[11px] text-ink-200 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
                    />
                  </td>
                ) : null}
                <td className="px-2 py-1.5 text-right">
                  {a.removable && !atMin ? (
                    <button
                      type="button"
                      onClick={() => onRemove(a.index)}
                      title={`Remove agent #${a.index}`}
                      className="w-6 h-6 rounded text-ink-400 hover:text-rose-300 hover:bg-rose-950/40 border border-transparent hover:border-rose-800/50 transition"
                    >
                      −
                    </button>
                  ) : (
                    <span className="w-6 h-6 inline-block" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {canAdd ? (
            <tfoot>
              <tr className="border-t border-ink-800/60">
                <td
                  colSpan={
                    4 + (showColor ? 1 : 0) + (showTag ? 1 : 0) + (showTemp ? 1 : 0) + (showPrompt ? 1 : 0)
                  }
                  className="px-2 py-1.5 text-right"
                >
                  <button
                    type="button"
                    onClick={onAdd}
                    title={`Add another ${addableRole}`}
                    className="text-[11px] px-2.5 py-1 rounded bg-ink-700 hover:bg-ink-600 text-ink-200 hover:text-ink-100 border border-ink-600 transition"
                  >
                    + add {addableRole}
                  </button>
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {atMax ? (
        <div className="text-[10px] text-ink-500 italic">
          At preset max ({preset.max}). Remove a row to add a different one.
        </div>
      ) : null}
    </div>
  );
}

// Convenience: build the initial topology when SetupForm picks a
// preset for the first time or the user switches presets. Phase 3
// adds a `lastUsed` opt-in that consults localStorage for the user's
// previous shape on this preset; SetupForm passes lastUsed=true on
// preset-change so switching back to a preset restores what the user
// had set up before. Fresh page-load also benefits since the
// auto-save survives reloads.
export function topologyForPreset(
  presetId: string,
  agentCount: number,
  options?: {
    dedicatedAuditor?: boolean;
    plannerModel?: string;
    workerModel?: string;
    auditorModel?: string;
    lastUsed?: boolean;
  },
): Topology {
  if (options?.lastUsed) {
    const recovered = readLastUsed(presetId);
    if (recovered && recovered.agents.length >= 1) return recovered;
  }
  return synthesizeTopology(presetId, agentCount, options);
}
