import { useState } from "react";
import { useSwarm } from "../state/store";

type PresetStatus = "active" | "planned";

interface SwarmPreset {
  id: string;
  label: string;
  summary: string;
  min: number;
  max: number;
  recommended: number;
  status: PresetStatus;
}

// Keep server-side cap (max=8) in mind when editing `max` values here.
// Patterns that theoretically scale higher (blackboard, stigmergy) are
// capped at 8 until their backends land.
const PRESETS: readonly SwarmPreset[] = [
  {
    id: "round-robin",
    label: "Round-robin transcript",
    summary: "N identical agents take turns; each sees the full transcript.",
    min: 2,
    max: 8,
    recommended: 3,
    status: "active",
  },
  {
    id: "blackboard",
    label: "Blackboard (optimistic + small units)",
    summary: "Planner posts todos; workers claim and commit in parallel. CAS on file hashes catches stale plans.",
    min: 3,
    max: 8,
    recommended: 6,
    status: "active",
  },
  {
    id: "role-diff",
    label: "Role differentiation",
    summary: "Architect, tester, critic, etc. — same weights, different system prompts.",
    min: 3,
    max: 8,
    recommended: 5,
    status: "active",
  },
  {
    id: "map-reduce",
    label: "Map-reduce over repo",
    summary: "Workers inspect slices in isolation; one reducer synthesizes.",
    min: 3,
    max: 8,
    recommended: 5,
    status: "planned",
  },
  {
    id: "council",
    label: "Council (parallel drafts + reconcile)",
    summary: "Round 1 independent drafts (peers hidden); Round 2+ reveal and revise.",
    min: 3,
    max: 8,
    recommended: 4,
    status: "active",
  },
  {
    id: "orchestrator-worker",
    label: "Orchestrator–worker hierarchy",
    summary: "Agent 1 plans subtasks, workers execute in parallel (isolated), lead synthesizes.",
    min: 2,
    max: 8,
    recommended: 4,
    status: "active",
  },
  {
    id: "debate-judge",
    label: "Debate + judge",
    summary: "PRO vs CON exchange arguments each round; JUDGE scores on the final round. Fixed 3 agents.",
    min: 3,
    max: 3,
    recommended: 3,
    status: "active",
  },
  {
    id: "stigmergy",
    label: "Stigmergy / pheromone trails",
    summary: "Agents annotate files with interest scores; others avoid covered ground.",
    min: 3,
    max: 8,
    recommended: 5,
    status: "planned",
  },
];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// Mirror of server's deriveCloneDir for the preview hint under the Parent
// folder field. Server is the source of truth; this is a best-effort UX
// preview. Returns "" if the URL isn't parseable yet (so the user gets the
// plain placeholder hint instead).
function buildPreviewClonePath(repoUrl: string, parentPath: string): string {
  if (!repoUrl || !parentPath) return "";
  let u: URL;
  try {
    u = new URL(repoUrl);
  } catch {
    return "";
  }
  const segments = u.pathname.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (!last) return "";
  const name = last.replace(/\.git$/i, "");
  if (!name) return "";
  const sep = parentPath.includes("\\") && !parentPath.includes("/") ? "\\" : "/";
  const trimmed = parentPath.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${name}`;
}

export function SetupForm() {
  const [repoUrl, setRepoUrl] = useState("https://github.com/sindresorhus/is-odd");
  const [parentPath, setParentPath] = useState("C:\\Users\\kevin\\Desktop\\ollama_swarm\\runs");
  const [presetId, setPresetId] = useState<string>("round-robin");
  const [agentCount, setAgentCount] = useState(3);
  const [model, setModel] = useState("glm-5.1:cloud");
  const [rounds, setRounds] = useState(3);
  const [busy, setBusy] = useState(false);
  const setError = useSwarm((s) => s.setError);
  const reset = useSwarm((s) => s.reset);

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const isActive = preset.status === "active";
  const previewClonePath = buildPreviewClonePath(repoUrl, parentPath);

  const onPresetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = PRESETS.find((p) => p.id === e.target.value);
    if (!next) return;
    setPresetId(next.id);
    setAgentCount(clamp(next.recommended, next.min, next.max));
  };

  const onAgentCountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.target.value);
    if (!Number.isFinite(raw)) return;
    setAgentCount(clamp(raw, preset.min, preset.max));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isActive) return;
    setBusy(true);
    setError(undefined);
    reset();
    try {
      const res = await fetch("/api/swarm/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, parentPath, agentCount, model, rounds, preset: preset.id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.formErrors?.[0] ?? body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto flex items-center justify-center p-8">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-xl bg-ink-800 border border-ink-700 rounded-lg p-6 space-y-4 shadow-xl"
      >
        <div>
          <h2 className="text-xl font-semibold mb-1">Start a swarm</h2>
          <p className="text-sm text-ink-400">
            Clone a GitHub repo and spawn N OpenCode agents inside it. Pick a pattern to decide how
            they collaborate.
          </p>
        </div>

        <Field label="GitHub URL" hint="Public repo, or private if GITHUB_TOKEN is set in .env">
          <input
            required
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            className="input"
            placeholder="https://github.com/owner/repo"
          />
        </Field>

        <Field
          label="Parent folder"
          hint={
            previewClonePath
              ? `The repo will be cloned into ${previewClonePath}`
              : "Parent folder. The repo is cloned into a subfolder named after the repo (e.g. is-odd)."
          }
        >
          <input
            required
            value={parentPath}
            onChange={(e) => setParentPath(e.target.value)}
            className="input font-mono"
            placeholder="C:\\Users\\you\\projects"
          />
        </Field>

        <Field
          label="Pattern"
          hint={
            isActive
              ? preset.summary
              : `${preset.summary} — not yet implemented; picking this disables Start.`
          }
        >
          <select value={presetId} onChange={onPresetChange} className="input">
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.status === "planned" ? " (coming soon)" : ""}
              </option>
            ))}
          </select>
        </Field>

        {preset.id === "blackboard" ? <BlackboardHelp /> : null}

        <div className="grid grid-cols-3 gap-4">
          <Field
            label="Agents"
            hint={
              preset.min === preset.max
                ? `Fixed at ${preset.min}`
                : `Min ${preset.min} · Max ${preset.max} · Fits ${preset.recommended}`
            }
          >
            <input
              type="number"
              min={preset.min}
              max={preset.max}
              value={agentCount}
              onChange={onAgentCountChange}
              className="input"
              disabled={preset.min === preset.max}
            />
          </Field>
          <Field label="Rounds">
            <input
              type="number"
              min={1}
              max={10}
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
              className="input"
            />
          </Field>
          <Field label="Model">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="input font-mono"
            />
          </Field>
        </div>

        <button
          type="submit"
          disabled={busy || !isActive}
          className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-ink-600 disabled:cursor-not-allowed text-white font-medium rounded px-4 py-2 transition"
        >
          {busy ? "Starting…" : isActive ? "Start swarm" : "Coming soon"}
        </button>

        <style>{`
          .input {
            width: 100%;
            background: #0b0d10;
            border: 1px solid #2a2f3a;
            border-radius: 6px;
            padding: 8px 10px;
            color: #e5e7eb;
            font-size: 14px;
          }
          .input:focus { outline: none; border-color: #10b981; }
          .input:disabled { opacity: 0.5; cursor: not-allowed; }
        `}</style>
      </form>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-wide text-ink-400 mb-1">{label}</div>
      {children}
      {hint ? <div className="text-xs text-ink-400 mt-1">{hint}</div> : null}
    </label>
  );
}

function BlackboardHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-ink-700 bg-ink-900/60 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-ink-300 hover:text-ink-100"
      >
        <span>How the blackboard preset coordinates work</span>
        <span className="text-ink-500">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="px-3 pb-3 space-y-1.5 text-ink-400 leading-snug">
          <p>
            <span className="text-ink-200">One planner, N−1 workers.</span> The planner posts atomic
            todos (≤2 files each) with <code className="font-mono text-ink-300">expectedFiles</code>.
            Workers claim a todo, record SHA hashes of the files they plan to touch, then return a
            full-file diff.
          </p>
          <p>
            <span className="text-ink-200">Optimistic CAS at commit.</span> Before the runner writes
            the diff, it re-hashes every claimed file. If any hash changed under the worker (another
            worker committed first), the commit is rejected and the todo is marked{" "}
            <span className="text-rose-300">stale</span>.
          </p>
          <p>
            <span className="text-ink-200">Stale → replan.</span> The planner re-reads the current
            code and rewrites the stale todo; the <span className="text-amber-300">R1/R2…</span>{" "}
            badge on a card counts how many times it's been replanned before another worker can
            reclaim it.
          </p>
          <p>
            <span className="text-ink-200">Hard caps bound every run.</span> 20 min wall-clock, 20
            commits, or 30 total todos — whichever fires first stops the loop and writes{" "}
            <code className="font-mono text-ink-300">summary.json</code> at the clone root.
          </p>
        </div>
      ) : null}
    </div>
  );
}
