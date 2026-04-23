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
    summary: "Mappers inspect a round-robin slice of top-level entries in isolation; reducer synthesizes.",
    min: 3,
    max: 8,
    recommended: 5,
    status: "active",
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
    summary: "Self-organizing repo exploration. Each agent picks a file based on a shared annotation table; untouched files attract, well-covered ones repel.",
    min: 2,
    max: 8,
    recommended: 5,
    status: "active",
  },
];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// Quick-fill text for the "Deliver README + research" chip below the
// user-directive textarea. One-click way to seed the planner with the
// directive we've been overnight-running on `kyahoofinance032926`.
const DIRECTIVE_README_AND_RESEARCH =
  "Make this project actually deliver every feature the README claims to support. Also, creatively enhance its functionalities by adding in more pipelines by conducting research online and then implement them";

// Unit 32: role-diff's customizable role list. Kept in sync with the
// server's DEFAULT_ROLES in server/src/swarm/roles.ts — edits there
// should be mirrored here (and vice versa) so the form's "reset to
// defaults" matches what the server falls back to. The duplication is
// deliberate: adding a `GET /api/defaults/roles` endpoint would be more
// moving parts than this catalog is worth.
export interface SwarmRoleWeb {
  name: string;
  guidance: string;
}
const DEFAULT_ROLES_WEB: readonly SwarmRoleWeb[] = [
  {
    name: "Architect",
    guidance:
      "Think in modules, data flow, and long-term evolution. Push back on sprawl, duplicated state, and abstractions that will calcify. Name the actual architectural choice you'd make and why.",
  },
  {
    name: "Tester",
    guidance:
      "Think about what could break. Name the edge cases, missing coverage, flaky surfaces, and hard-to-reproduce conditions. When you propose a test, say what it asserts, not just 'add a test'.",
  },
  {
    name: "Security reviewer",
    guidance:
      "Look for injection, auth gaps, exposed secrets, supply-chain risk, and unsafe defaults. Cite the specific line or dependency. If you see nothing to flag, say so — don't invent threats.",
  },
  {
    name: "Performance critic",
    guidance:
      "Look for hot paths, N+1 patterns, unnecessary allocations, blocking I/O on request paths, and cache misses. Give a rough order-of-magnitude on what it costs and where you'd measure first.",
  },
  {
    name: "Docs reader",
    guidance:
      "Read as a new contributor arriving cold. What's confusing, missing, or contradicted by the code? Does the README explain what this project is and isn't? Is CONTRIBUTING runnable end-to-end?",
  },
  {
    name: "Dependency auditor",
    guidance:
      "Inspect package.json and lockfiles. Pinned vs floating, bloat, abandoned packages, duplicated transitive graphs. Flag anything shipping non-standard minified code or installing post-install scripts.",
  },
  {
    name: "Devil's advocate",
    guidance:
      "Challenge the emerging consensus. Ask whether the proposed next action is the *right* next action or just the most visible one. If the swarm agrees too quickly, that's your signal to push back.",
  },
];
const MAX_ROLES = 16;
const MAX_ROLE_NAME_LEN = 80;
const MAX_ROLE_GUIDANCE_LEN = 2000;

// Tri-state for the blackboard council-contract knob.
// "" = inherit server default (COUNCIL_CONTRACT_ENABLED env var).
// "on" = force on for this run. "off" = force off for this run.
type CouncilContractPref = "" | "on" | "off";

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
  const [repoUrl, setRepoUrl] = useState("https://github.com/kevinkicho");
  const [parentPath, setParentPath] = useState("C:\\users\\you\\projects");
  const [presetId, setPresetId] = useState<string>("round-robin");
  const [agentCount, setAgentCount] = useState(3);
  const [model, setModel] = useState("glm-5.1:cloud");
  const [rounds, setRounds] = useState(3);
  const [userDirective, setUserDirective] = useState("");
  // Unit 32: per-preset knobs. State lives in SetupForm so it persists
  // across preset-switch round-trips (user flips blackboard → role-diff
  // → blackboard without losing what they typed). Only the knob matching
  // the current preset gets sent on submit.
  const [roles, setRoles] = useState<SwarmRoleWeb[]>(() => DEFAULT_ROLES_WEB.map((r) => ({ ...r })));
  const [councilContractPref, setCouncilContractPref] = useState<CouncilContractPref>("");
  const [proposition, setProposition] = useState("");
  // Unit 42: per-agent model overrides (blackboard-only). Empty string
  // means "fall through to the main Model field" — same shape as the
  // server falls back to cfg.model when these are absent.
  const [plannerModel, setPlannerModel] = useState("");
  const [workerModel, setWorkerModel] = useState("");
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
      // Unit 32: preset-specific knobs. Only send the knob relevant to
      // the selected preset; the others would be silently ignored by the
      // server anyway but this keeps the POST body clean and makes intent
      // obvious in the event log.
      const presetSpecific: Record<string, unknown> = {};
      if (preset.id === "role-diff") {
        // Sanitize: drop rows that are entirely empty (user removed
        // content but didn't delete the row). Server validates
        // non-empty name + guidance, so trimmed empties would 400.
        const cleaned = roles
          .map((r) => ({ name: r.name.trim(), guidance: r.guidance.trim() }))
          .filter((r) => r.name.length > 0 && r.guidance.length > 0);
        if (cleaned.length > 0) presetSpecific.roles = cleaned;
      }
      if (preset.id === "blackboard" && councilContractPref !== "") {
        presetSpecific.councilContract = councilContractPref === "on";
      }
      if (preset.id === "debate-judge" && proposition.trim().length > 0) {
        presetSpecific.proposition = proposition.trim();
      }
      // Unit 42: blackboard-only per-agent model overrides. Trimmed
      // empty → omit the field so the server falls back to cfg.model.
      if (preset.id === "blackboard") {
        const pm = plannerModel.trim();
        const wm = workerModel.trim();
        if (pm.length > 0) presetSpecific.plannerModel = pm;
        if (wm.length > 0) presetSpecific.workerModel = wm;
      }

      const res = await fetch("/api/swarm/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl,
          parentPath,
          agentCount,
          model,
          rounds,
          preset: preset.id,
          // Unit 25: shape blackboard's first-pass contract via a user
          // directive. Trimmed/empty goes as undefined (zod strips anyway).
          userDirective: userDirective.trim() || undefined,
          ...presetSpecific,
        }),
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

        <Field
          label="User directive (optional)"
          hint={
            preset.id === "blackboard"
              ? "Blackboard only — shapes the auto-generated contract from turn 1. Leave empty for the planner's own read of repo gaps. Max 4000 chars."
              : "This preset has no auto-contract, so the directive is ignored. It only applies to the Blackboard preset."
          }
        >
          <textarea
            value={userDirective}
            onChange={(e) => setUserDirective(e.target.value.slice(0, 4000))}
            placeholder="e.g., Make this project actually deliver every feature the README claims to support."
            rows={3}
            className="input"
            style={{ fontFamily: "inherit", resize: "vertical", minHeight: 60 }}
          />
          <button
            type="button"
            onClick={() => setUserDirective(DIRECTIVE_README_AND_RESEARCH)}
            title="Click to paste this preset directive into the field above"
            className="mt-2 inline-block text-xs px-3 py-1 rounded-full bg-ink-700 hover:bg-ink-600 text-ink-300 hover:text-ink-100 border border-ink-600 transition"
          >
            + Deliver every README feature + research
          </button>
        </Field>

        <PresetAdvancedSettings
          presetId={preset.id}
          roles={roles}
          setRoles={setRoles}
          councilContractPref={councilContractPref}
          setCouncilContractPref={setCouncilContractPref}
          proposition={proposition}
          setProposition={setProposition}
          plannerModel={plannerModel}
          setPlannerModel={setPlannerModel}
          workerModel={workerModel}
          setWorkerModel={setWorkerModel}
          fallbackModel={model}
        />

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
              max={100}
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
            <span className="text-ink-200">Hard caps bound every run.</span> 8 hours wall-clock,
            200 commits, or 300 total todos — whichever fires first stops the loop and writes{" "}
            <code className="font-mono text-ink-300">summary.json</code> at the clone root. Unit 27
            compensates for laptop-sleep so a multi-hour suspension doesn't silently burn the cap.
          </p>
        </div>
      ) : null}
    </div>
  );
}

// Unit 32: wrapper for the per-preset Advanced Settings section.
// Renders nothing for presets with no knobs today (round-robin,
// council, orchestrator-worker, map-reduce, stigmergy) — future
// units can add branches as they surface new knobs.
function PresetAdvancedSettings(props: {
  presetId: string;
  roles: SwarmRoleWeb[];
  setRoles: (r: SwarmRoleWeb[]) => void;
  councilContractPref: CouncilContractPref;
  setCouncilContractPref: (p: CouncilContractPref) => void;
  proposition: string;
  setProposition: (p: string) => void;
  plannerModel: string;
  setPlannerModel: (m: string) => void;
  workerModel: string;
  setWorkerModel: (m: string) => void;
  fallbackModel: string;
}) {
  const [open, setOpen] = useState(false);
  const {
    presetId,
    roles,
    setRoles,
    councilContractPref,
    setCouncilContractPref,
    proposition,
    setProposition,
    plannerModel,
    setPlannerModel,
    workerModel,
    setWorkerModel,
    fallbackModel,
  } = props;

  const hasAdvanced =
    presetId === "role-diff" ||
    presetId === "blackboard" ||
    presetId === "debate-judge";
  if (!hasAdvanced) return null;

  const label = (() => {
    switch (presetId) {
      case "role-diff":
        return "Advanced settings — role catalog";
      case "blackboard":
        return "Advanced settings — council-contract draft + per-agent models";
      case "debate-judge":
        return "Advanced settings — proposition";
      default:
        return "Advanced settings";
    }
  })();

  return (
    <div className="rounded border border-ink-700 bg-ink-900/60 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-ink-300 hover:text-ink-100"
      >
        <span>{label}</span>
        <span className="text-ink-500">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="px-3 pb-3 pt-1 space-y-2">
          {presetId === "role-diff" ? (
            <RoleDiffAdvanced roles={roles} setRoles={setRoles} />
          ) : null}
          {presetId === "blackboard" ? (
            <>
              <BlackboardAdvanced
                pref={councilContractPref}
                setPref={setCouncilContractPref}
              />
              <BlackboardModelOverrides
                plannerModel={plannerModel}
                setPlannerModel={setPlannerModel}
                workerModel={workerModel}
                setWorkerModel={setWorkerModel}
                fallbackModel={fallbackModel}
              />
            </>
          ) : null}
          {presetId === "debate-judge" ? (
            <DebateJudgeAdvanced
              proposition={proposition}
              setProposition={setProposition}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BlackboardModelOverrides({
  plannerModel,
  setPlannerModel,
  workerModel,
  setWorkerModel,
  fallbackModel,
}: {
  plannerModel: string;
  setPlannerModel: (m: string) => void;
  workerModel: string;
  setWorkerModel: (m: string) => void;
  fallbackModel: string;
}) {
  return (
    <div className="space-y-2">
      <Field
        label="Planner model override (Unit 42)"
        hint={
          plannerModel.trim().length === 0
            ? `Empty → uses the main Model field (${fallbackModel}). Planner-hosted critic / replanner / auditor sessions inherit this too.`
            : `Planner + critic + replanner + auditor will run on ${plannerModel.trim()}.`
        }
      >
        <input
          value={plannerModel}
          onChange={(e) => setPlannerModel(e.target.value.slice(0, 200))}
          placeholder={`(default: ${fallbackModel})`}
          className="input font-mono"
        />
      </Field>
      <Field
        label="Worker model override (Unit 42)"
        hint={
          workerModel.trim().length === 0
            ? `Empty → uses the main Model field (${fallbackModel}). All worker agents (indices 2..N) share this model.`
            : `All worker agents will run on ${workerModel.trim()}.`
        }
      >
        <input
          value={workerModel}
          onChange={(e) => setWorkerModel(e.target.value.slice(0, 200))}
          placeholder={`(default: ${fallbackModel})`}
          className="input font-mono"
        />
      </Field>
    </div>
  );
}

function RoleDiffAdvanced({
  roles,
  setRoles,
}: {
  roles: SwarmRoleWeb[];
  setRoles: (r: SwarmRoleWeb[]) => void;
}) {
  const updateAt = (i: number, patch: Partial<SwarmRoleWeb>) => {
    setRoles(roles.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const removeAt = (i: number) => {
    setRoles(roles.filter((_, idx) => idx !== i));
  };
  const addRole = () => {
    if (roles.length >= MAX_ROLES) return;
    setRoles([...roles, { name: "", guidance: "" }]);
  };
  const resetDefaults = () => {
    setRoles(DEFAULT_ROLES_WEB.map((r) => ({ ...r })));
  };

  const atLimit = roles.length >= MAX_ROLES;

  return (
    <div className="text-ink-300 space-y-2">
      <p className="text-ink-400 leading-snug">
        Role differentiation cycles these roles across agents (agent 1 → role 1, agent 2 → role 2,
        …, wrapping). Each role's guidance prepends the round-robin prompt, so identical model
        weights produce distinct priors. Edit, remove, or reset — the server falls back to its own
        defaults if this list is empty.
      </p>
      <div className="flex items-center justify-between text-ink-500">
        <span>
          {roles.length} / {MAX_ROLES} roles
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={resetDefaults}
            className="text-xs px-2 py-0.5 rounded-full bg-ink-700 hover:bg-ink-600 text-ink-300 hover:text-ink-100 border border-ink-600"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={addRole}
            disabled={atLimit}
            className="text-xs px-2 py-0.5 rounded-full bg-ink-700 hover:bg-ink-600 text-ink-300 hover:text-ink-100 border border-ink-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            + Add role
          </button>
        </div>
      </div>
      <div className="space-y-2">
        {roles.map((r, i) => (
          <div
            key={i}
            className="border border-ink-700 rounded px-2 py-2 bg-ink-900/40 space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <span className="text-ink-500 text-xs shrink-0 w-10">#{i + 1}</span>
              <input
                value={r.name}
                maxLength={MAX_ROLE_NAME_LEN}
                onChange={(e) => updateAt(i, { name: e.target.value })}
                className="input flex-1"
                placeholder="Role name (e.g., Architect)"
              />
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`Remove role ${i + 1}`}
                className="shrink-0 text-xs px-2 py-0.5 rounded bg-ink-800 hover:bg-rose-700/50 text-ink-400 hover:text-rose-100 border border-ink-700"
              >
                Remove
              </button>
            </div>
            <textarea
              value={r.guidance}
              maxLength={MAX_ROLE_GUIDANCE_LEN}
              onChange={(e) => updateAt(i, { guidance: e.target.value })}
              rows={2}
              className="input"
              placeholder="Guidance for this role — prepended to the agent's round-robin prompt."
              style={{ fontFamily: "inherit", resize: "vertical", minHeight: 44 }}
            />
          </div>
        ))}
        {roles.length === 0 ? (
          <div className="text-ink-500 italic">
            No custom roles. Leaving empty sends no role list, so the server falls back to its
            default 7-role catalog.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BlackboardAdvanced({
  pref,
  setPref,
}: {
  pref: CouncilContractPref;
  setPref: (p: CouncilContractPref) => void;
}) {
  return (
    <Field
      label="Council-style contract draft (Unit 30)"
      hint="Blackboard only. When enabled, all N agents independently draft a first-pass contract at turn 0, then the planner merges them into one. Inherit = use the COUNCIL_CONTRACT_ENABLED env var."
    >
      <select
        value={pref}
        onChange={(e) => setPref(e.target.value as CouncilContractPref)}
        className="input"
      >
        <option value="">Inherit from server default (env flag)</option>
        <option value="on">Enable for this run</option>
        <option value="off">Disable for this run</option>
      </select>
    </Field>
  );
}

function DebateJudgeAdvanced({
  proposition,
  setProposition,
}: {
  proposition: string;
  setProposition: (p: string) => void;
}) {
  return (
    <Field
      label="Proposition"
      hint="The claim PRO argues for and CON argues against. Leave empty for the built-in default (“This project is ready for production use”). Max 2000 chars."
    >
      <textarea
        value={proposition}
        onChange={(e) => setProposition(e.target.value.slice(0, 2000))}
        placeholder="This project is ready for production use"
        rows={2}
        className="input"
        style={{ fontFamily: "inherit", resize: "vertical", minHeight: 44 }}
      />
    </Field>
  );
}
