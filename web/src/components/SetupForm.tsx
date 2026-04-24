import { useState } from "react";
import { useSwarm } from "../state/store";
import { PreflightPreview } from "./PreflightPreview";

type PresetStatus = "active" | "planned";

interface SwarmPreset {
  id: string;
  label: string;
  summary: string;
  min: number;
  max: number;
  recommended: number;
  // Per-preset recommended model for the main Model field. Two-tier
  // framework: REASONING for presets where every / the dominant agent
  // makes judgment calls (planner, drafter, judge, synthesizer);
  // CODING for presets where every agent produces structured output
  // against a clear spec (stigmergy file-summarization). When the
  // preset is multi-role (blackboard, map-reduce, etc.) this is the
  // model the highest-leverage role wants — per-agent overrides
  // refine the rest.
  recommendedModel: string;
  status: PresetStatus;
}

// Two-tier model framework — see docs/autonomous-productivity.md
// "Per-preset distribution" for the full rationale.
//   REASONING — judgment, decomposition, synthesis, multi-step
//     deliberation. Use for planners, drafters, judges, reducers,
//     orchestrators, peer-dialogue presets.
//   CODING — structured-output emission against a clear spec
//     (diffs, file summaries). Faster + cheaper than reasoning;
//     correct trade-off for blackboard workers and stigmergy peers.
//   VERIFIER — heaviest reasoning model, reserved for the auditor
//     role where rubber-stamping is the dominant failure mode.
//
// 2026-04-23: REASONING flipped from glm-5.1:cloud to
// nemotron-3-super:cloud after the vocabmaster v7 4-agent run
// showed nemotron mean=9.5s vs glm mean=57s on the auditor, and
// the multi-agent-orchestrator preset tour showed glm producing
// repeated empty responses on parallel-spawn fanout (Agent 3
// pattern across role-diff + council). Nemotron now serves both
// REASONING and VERIFIER duty; constants kept separate so a
// future heavier verifier model (opus 4.7, kimi-2.6) can split
// them again without touching every preset.
const MODEL_REASONING = "nemotron-3-super:cloud";
const MODEL_CODING = "gemma4:31b-cloud";
const MODEL_VERIFIER = "nemotron-3-super:cloud";

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
    recommendedModel: MODEL_REASONING,
    status: "active",
  },
  {
    id: "blackboard",
    label: "Blackboard (optimistic + small units)",
    summary: "Planner posts todos; workers claim and commit in parallel. CAS on file hashes catches stale plans.",
    min: 3,
    max: 8,
    recommended: 6,
    // Main Model = the planner's tier. Per-agent overrides
    // (BLACKBOARD_DEFAULT_*_MODEL) refine workers + auditor.
    recommendedModel: MODEL_REASONING,
    status: "active",
  },
  {
    id: "role-diff",
    label: "Role differentiation",
    summary: "Architect, tester, critic, etc. — same weights, different system prompts.",
    min: 3,
    max: 8,
    recommended: 5,
    recommendedModel: MODEL_REASONING,
    status: "active",
  },
  {
    id: "map-reduce",
    label: "Map-reduce over repo",
    summary: "Mappers inspect a round-robin slice of top-level entries in isolation; reducer synthesizes.",
    min: 3,
    max: 8,
    recommended: 5,
    // Single-model preset today — pick reducer's tier so synthesis
    // doesn't bottleneck. When per-role model selection ships
    // (Unit 65 candidate), swap mappers to MODEL_CODING.
    recommendedModel: MODEL_REASONING,
    status: "active",
  },
  {
    id: "council",
    label: "Council (parallel drafts + reconcile)",
    summary: "Round 1 independent drafts (peers hidden); Round 2+ reveal and revise.",
    min: 3,
    max: 8,
    recommended: 4,
    // All N drafters need actual angles; coding-tier produces
    // near-identical drafts → no diversity gain.
    recommendedModel: MODEL_REASONING,
    status: "active",
  },
  {
    id: "orchestrator-worker",
    label: "Orchestrator–worker hierarchy",
    summary: "Agent 1 plans subtasks, workers execute in parallel (isolated), lead synthesizes.",
    min: 2,
    max: 8,
    recommended: 4,
    // Single-model preset today — pick orchestrator's tier. Same
    // Unit 65 candidate as map-reduce.
    recommendedModel: MODEL_REASONING,
    status: "active",
  },
  {
    id: "debate-judge",
    label: "Debate + judge",
    summary: "PRO vs CON exchange arguments each round; JUDGE scores on the final round. Fixed 3 agents.",
    min: 3,
    max: 3,
    recommended: 3,
    // All three roles need higher-reasoning. Heterogeneous-judge
    // (PRO/CON on one model, JUDGE on another) is a Unit 65
    // candidate — bias mitigation gain isn't huge.
    recommendedModel: MODEL_REASONING,
    status: "active",
  },
  {
    id: "stigmergy",
    label: "Stigmergy / pheromone trails",
    summary: "Self-organizing repo exploration. Each agent picks a file based on a shared annotation table; untouched files attract, well-covered ones repel.",
    min: 2,
    max: 8,
    recommended: 5,
    // Each task is read-and-summarize; coding-tier finishes faster
    // → more parallel coverage per minute. Coordination is via the
    // pheromone table, not deliberation, so reasoning doesn't pay.
    recommendedModel: MODEL_CODING,
    status: "active",
  },
];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// Quick-fill text for the "Deliver README + research" chip below the
// user-directive textarea. One-click way to seed the planner with the
// directive we've been overnight-running on `kyahoofinance032926`.
const DIRECTIVE_README_AND_RESEARCH =
  "Make this project actually deliver every feature the README claims to support. Also, creatively enhance its functionalities by adding in more pipelines by conducting research online and then implement them";

// Unit 63: one-click "Multi-hour autonomous" preset. Single source of
// truth so the chip's button label stays in sync if these defaults
// shift later. 8 h cap + 5 tiers matches the north-star scenario in
// docs/autonomous-productivity.md.
const MULTI_HOUR_CAP_MIN = 480;
const MULTI_HOUR_TIERS = 5;

// Blackboard role defaults. Maps each role to its tier from the
// MODEL_REASONING / MODEL_CODING / MODEL_VERIFIER framework above.
// Pre-populated as initial state for the matching SetupForm inputs;
// users can clear to fall through to the main Model field.
const BLACKBOARD_DEFAULT_PLANNER_MODEL = MODEL_REASONING;
const BLACKBOARD_DEFAULT_WORKER_MODEL = MODEL_CODING;
const BLACKBOARD_DEFAULT_AUDITOR_MODEL = MODEL_VERIFIER;

// Improvement #2 from 2026-04-23 retro: wall-clock budget estimator.
// Mean per-turn seconds observed during today's vocabmaster + multi-
// agent-orchestrator runs. The 7-preset tour exposed that rounds=5
// with N≥3 agents on glm-5.1 needed ~25 min, not 15 — Kevin's
// budget was systematically 50% short.
//
// MODEL_TURN_SECONDS maps the dominant model to its observed mean
// turn time (success path). Falls back to 60s for unknown models.
// Update as new runs widen the dataset.
const MODEL_TURN_SECONDS: Record<string, number> = {
  "nemotron-3-super:cloud": 30,
  "glm-5.1:cloud": 70,
  "gemma4:31b-cloud": 30,
};
const DEFAULT_TURN_SECONDS = 60;

function turnSecondsForModel(model: string): number {
  return MODEL_TURN_SECONDS[model.trim()] ?? DEFAULT_TURN_SECONDS;
}

// Per-preset wall-clock estimator. Returns seconds. Each preset's
// per-round shape determines the multiplier:
//   - SEQUENTIAL (round-robin, role-diff, council reveal, debate):
//     each round is N agents prompted in sequence → N × turn × R
//   - PARALLEL FANOUT (stigmergy): all N agents fire concurrently
//     each round → 1 × turn × R (best case; cloud may serialize)
//   - HIERARCHICAL (orchestrator-worker, map-reduce, council draft):
//     1 lead + N-1 parallel children → ~2 × turn × R (lead twice)
//   - BLACKBOARD: not rounds-based; estimator returns null and the
//     UI shows "uses wall-clock cap" instead.
// Includes a 1.2× safety margin baked in (cloud variance).
function estimateWallClockSeconds(
  presetId: string,
  agentCount: number,
  rounds: number,
  mainModel: string,
): number | null {
  const t = turnSecondsForModel(mainModel);
  const r = Math.max(1, rounds);
  const n = Math.max(1, agentCount);
  const SAFETY = 1.2;
  switch (presetId) {
    case "blackboard":
      return null;
    case "round-robin":
    case "role-diff":
    case "council":
      return Math.round(n * t * r * SAFETY);
    case "debate-judge":
      // Focused turns (PRO/CON/JUDGE) typically run ~30% faster.
      return Math.round(3 * t * r * SAFETY * 0.7);
    case "orchestrator-worker":
    case "map-reduce":
      // Lead runs twice per round (plan + synth); workers in parallel.
      return Math.round(2 * t * r * SAFETY);
    case "stigmergy":
      return Math.round(t * r * SAFETY);
    default:
      return Math.round(n * t * r * SAFETY);
  }
}

function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

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
  // Model defaults to the initial preset's recommendation so the
  // form renders with a sensible Model field on first paint.
  // onPresetChange refreshes this when the user switches presets.
  const [model, setModel] = useState(PRESETS[0].recommendedModel);
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
  // server falls back to cfg.model when these are absent. The non-
  // empty initial values are the recommended blackboard model mix
  // (see BLACKBOARD_DEFAULT_*_MODEL above); silently ignored on
  // non-blackboard presets since the submit handler only POSTs them
  // when preset === "blackboard".
  const [plannerModel, setPlannerModel] = useState(BLACKBOARD_DEFAULT_PLANNER_MODEL);
  const [workerModel, setWorkerModel] = useState(BLACKBOARD_DEFAULT_WORKER_MODEL);
  // Unit 43: per-run wall-clock cap (minutes). Empty = use the 8-h
  // baked-in default. UI is in MINUTES; we send ms over the wire.
  const [wallClockCapMin, setWallClockCapMin] = useState("");
  // Unit 63: per-run ambition-tier cap. Blackboard-only. Empty = use
  // env default (today: off). 0–20 matches the route Zod cap. The
  // server-side knob (Unit 34) interprets 0 as "stop on first all-met"
  // and 1+ as "climb that many tiers".
  const [ambitionTiers, setAmbitionTiers] = useState("");
  // Unit 63 follow-on: knobs that exist server-side (Units 36, 58, 59,
  // 60) but were never wired to the SetupForm. Same shape as the rest
  // of the blackboard-only state — empty / false = inherit defaults.
  // Default-on: vocabmaster v7 4-agent run (2026-04-23) showed
  // dedicated auditor on nemotron-3-super was 5-12× faster than
  // planner-as-auditor on glm-5.1, AND freed the planner to focus
  // on todo authorship (planner mean latency halved 117s→57s).
  // No downside on cost — one extra subprocess per run.
  const [dedicatedAuditor, setDedicatedAuditor] = useState(true);
  const [auditorModel, setAuditorModel] = useState(BLACKBOARD_DEFAULT_AUDITOR_MODEL);
  const [specializedWorkers, setSpecializedWorkers] = useState(false);
  const [criticEnsemble, setCriticEnsemble] = useState(false);
  const [uiUrl, setUiUrl] = useState("");
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
    // Match the agentCount auto-update pattern: switching presets
    // also flips the main Model to the new preset's recommendation
    // (e.g. round-robin → stigmergy lands you on MODEL_CODING).
    // User can override after.
    setModel(next.recommendedModel);
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
        // Unit 43: convert minutes → ms; clamp client-side so a typo
        // doesn't 400 at the route. Server enforces 1 min … 8 h too.
        const capMin = Number(wallClockCapMin.trim());
        if (Number.isFinite(capMin) && capMin >= 1 && capMin <= 480) {
          presetSpecific.wallClockCapMs = Math.round(capMin * 60_000);
        }
        // Unit 63: ambition tier cap. Empty → omit (server falls back
        // to env default). Otherwise send the integer; route Zod
        // accepts 0–20 and 0 explicitly disables the ratchet.
        const tiersTrim = ambitionTiers.trim();
        if (tiersTrim.length > 0) {
          const tiers = Number(tiersTrim);
          if (Number.isInteger(tiers) && tiers >= 0 && tiers <= 20) {
            presetSpecific.ambitionTiers = tiers;
          }
        }
        // Unit 63 follow-on: only POST true. Sending dedicatedAuditor:
        // false would still be valid but adds noise to the event log,
        // and the runner reads `cfg.dedicatedAuditor === true` either
        // way. Same for the worker / critic toggles.
        if (dedicatedAuditor) presetSpecific.dedicatedAuditor = true;
        const am = auditorModel.trim();
        if (dedicatedAuditor && am.length > 0) {
          presetSpecific.auditorModel = am;
        }
        if (specializedWorkers) presetSpecific.specializedWorkers = true;
        if (criticEnsemble) presetSpecific.criticEnsemble = true;
        // Unit 36: outside-world UI URL the auditor's swarm-ui agent
        // navigates to. Server validates as a real URL (z.string().url()),
        // so trim and only send when non-empty.
        const ui = uiUrl.trim();
        if (ui.length > 0) presetSpecific.uiUrl = ui;
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

        <PreflightPreview repoUrl={repoUrl} parentPath={parentPath} />

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
          wallClockCapMin={wallClockCapMin}
          setWallClockCapMin={setWallClockCapMin}
          ambitionTiers={ambitionTiers}
          setAmbitionTiers={setAmbitionTiers}
          dedicatedAuditor={dedicatedAuditor}
          setDedicatedAuditor={setDedicatedAuditor}
          auditorModel={auditorModel}
          setAuditorModel={setAuditorModel}
          specializedWorkers={specializedWorkers}
          setSpecializedWorkers={setSpecializedWorkers}
          criticEnsemble={criticEnsemble}
          setCriticEnsemble={setCriticEnsemble}
          uiUrl={uiUrl}
          setUiUrl={setUiUrl}
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

        <WallClockEstimate
          presetId={preset.id}
          agentCount={agentCount}
          rounds={rounds}
          mainModel={model}
          wallClockCapMin={wallClockCapMin}
        />

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

// Improvement #2 from 2026-04-23 retro: wall-clock budget hint that
// renders right above the Start button. Pulls observed per-model
// turn-second data + per-preset shape from the helpers up top.
//
// For blackboard the estimator returns null (not rounds-based); we
// show "uses wall-clock cap" + the cap value if the user set one.
//
// For everything else: render the estimate, plus a comparison vs the
// wall-clock cap when the user set one. Color-codes: green when
// estimate fits comfortably (< 80% of cap or no cap), amber when
// close (80-120%), rose when likely to truncate (> 120%).
function WallClockEstimate({
  presetId,
  agentCount,
  rounds,
  mainModel,
  wallClockCapMin,
}: {
  presetId: string;
  agentCount: number;
  rounds: number;
  mainModel: string;
  wallClockCapMin: string;
}) {
  if (presetId === "blackboard") {
    const cap = wallClockCapMin.trim();
    const capParsed = Number(cap);
    const capValid = cap.length > 0 && Number.isFinite(capParsed) && capParsed >= 1;
    return (
      <div className="text-xs text-ink-400 px-1">
        Blackboard runs are gated by wall-clock cap, not rounds.{" "}
        {capValid
          ? `This run will stop after ~${capParsed} min.`
          : "Defaulting to the 8 h baked-in cap (override in Advanced settings)."}
      </div>
    );
  }
  const seconds = estimateWallClockSeconds(presetId, agentCount, rounds, mainModel);
  if (seconds === null) return null;
  const cap = wallClockCapMin.trim();
  const capMinParsed = Number(cap);
  const capValid = cap.length > 0 && Number.isFinite(capMinParsed) && capMinParsed >= 1;
  const capSec = capValid ? Math.round(capMinParsed * 60) : null;

  let color = "text-ink-400";
  let suffix = "";
  if (capSec !== null) {
    const ratio = seconds / capSec;
    if (ratio > 1.2) {
      color = "text-rose-300";
      suffix = ` — likely to hit the ${formatDurationSeconds(capSec)} cap before finishing rounds=${rounds}`;
    } else if (ratio > 0.8) {
      color = "text-amber-300";
      suffix = ` — close to the ${formatDurationSeconds(capSec)} cap, may truncate`;
    } else {
      color = "text-emerald-300";
      suffix = ` — fits inside the ${formatDurationSeconds(capSec)} cap`;
    }
  }
  return (
    <div className={`text-xs ${color} px-1`}>
      Estimated wall-clock: ~{formatDurationSeconds(seconds)}
      {suffix}.
      <div className="text-ink-500 mt-0.5">
        Based on {turnSecondsForModel(mainModel)}s/turn for {mainModel || "(unknown model)"} × {presetId} shape ×
        rounds={rounds}, agents={agentCount}, with 1.2× safety margin.
      </div>
    </div>
  );
}

// Boolean checkbox styled to fit the same Field rhythm. Used for the
// blackboard topology toggles (Units 58 / 59 / 60). The label wraps
// the input so clicking the title toggles too.
function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="block cursor-pointer">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-emerald-500"
        />
        <span className="text-xs uppercase tracking-wide text-ink-400">{label}</span>
      </div>
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
  wallClockCapMin: string;
  setWallClockCapMin: (s: string) => void;
  ambitionTiers: string;
  setAmbitionTiers: (s: string) => void;
  dedicatedAuditor: boolean;
  setDedicatedAuditor: (v: boolean) => void;
  auditorModel: string;
  setAuditorModel: (s: string) => void;
  specializedWorkers: boolean;
  setSpecializedWorkers: (v: boolean) => void;
  criticEnsemble: boolean;
  setCriticEnsemble: (v: boolean) => void;
  uiUrl: string;
  setUiUrl: (s: string) => void;
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
    wallClockCapMin,
    setWallClockCapMin,
    ambitionTiers,
    setAmbitionTiers,
    dedicatedAuditor,
    setDedicatedAuditor,
    auditorModel,
    setAuditorModel,
    specializedWorkers,
    setSpecializedWorkers,
    criticEnsemble,
    setCriticEnsemble,
    uiUrl,
    setUiUrl,
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
        return "Advanced settings — contract, models, caps, agent topology, live URL";
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
              <BlackboardWallClockCap
                wallClockCapMin={wallClockCapMin}
                setWallClockCapMin={setWallClockCapMin}
              />
              <BlackboardAmbitionTiers
                ambitionTiers={ambitionTiers}
                setAmbitionTiers={setAmbitionTiers}
                wallClockCapMin={wallClockCapMin}
              />
              <MultiHourPresetChip
                setWallClockCapMin={setWallClockCapMin}
                setAmbitionTiers={setAmbitionTiers}
              />
              <BlackboardAgentTopology
                dedicatedAuditor={dedicatedAuditor}
                setDedicatedAuditor={setDedicatedAuditor}
                auditorModel={auditorModel}
                setAuditorModel={setAuditorModel}
                specializedWorkers={specializedWorkers}
                setSpecializedWorkers={setSpecializedWorkers}
                criticEnsemble={criticEnsemble}
                setCriticEnsemble={setCriticEnsemble}
                fallbackModel={fallbackModel}
              />
              <BlackboardUiUrl uiUrl={uiUrl} setUiUrl={setUiUrl} />
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
            ? `Empty → uses the main Model field (${fallbackModel}). Planner-hosted critic / replanner / auditor sessions inherit this too. Recommended for blackboard: ${BLACKBOARD_DEFAULT_PLANNER_MODEL}.`
            : `Planner + critic + replanner + auditor will run on ${plannerModel.trim()}.`
        }
      >
        <input
          value={plannerModel}
          onChange={(e) => setPlannerModel(e.target.value.slice(0, 200))}
          placeholder={`(blackboard recommended: ${BLACKBOARD_DEFAULT_PLANNER_MODEL})`}
          className="input font-mono"
        />
      </Field>
      <Field
        label="Worker model override (Unit 42)"
        hint={
          workerModel.trim().length === 0
            ? `Empty → uses the main Model field (${fallbackModel}). All worker agents (indices 2..N) share this model. Recommended for blackboard: ${BLACKBOARD_DEFAULT_WORKER_MODEL} (fast, code-shaped).`
            : `All worker agents will run on ${workerModel.trim()}.`
        }
      >
        <input
          value={workerModel}
          onChange={(e) => setWorkerModel(e.target.value.slice(0, 200))}
          placeholder={`(blackboard recommended: ${BLACKBOARD_DEFAULT_WORKER_MODEL})`}
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

function BlackboardWallClockCap({
  wallClockCapMin,
  setWallClockCapMin,
}: {
  wallClockCapMin: string;
  setWallClockCapMin: (s: string) => void;
}) {
  const trimmed = wallClockCapMin.trim();
  const parsed = Number(trimmed);
  const isValid = trimmed.length === 0 || (Number.isFinite(parsed) && parsed >= 1 && parsed <= 480);
  return (
    <Field
      label="Wall-clock cap minutes (Unit 43)"
      hint={
        trimmed.length === 0
          ? "Empty → uses the 8-hour baked-in default. Enter a number 1–480 to cap THIS run only."
          : isValid
            ? `Run will stop after ~${parsed} min of active wall-clock time (host-sleep is still clamped per Unit 27).`
            : "Out of range — enter a number between 1 and 480, or leave empty for the 8 h default."
      }
    >
      <input
        value={wallClockCapMin}
        onChange={(e) => setWallClockCapMin(e.target.value)}
        placeholder="(default: 480)"
        className={`input font-mono ${!isValid ? "border-rose-500" : ""}`}
        inputMode="numeric"
      />
    </Field>
  );
}

// Unit 63a: ambition-tier cap input. Empty = inherit env default
// (today: off). The soft warning fires when tiers > 0 AND the
// wall-clock cap is short enough that a second tier almost
// certainly won't have time to make meaningful progress.
function BlackboardAmbitionTiers({
  ambitionTiers,
  setAmbitionTiers,
  wallClockCapMin,
}: {
  ambitionTiers: string;
  setAmbitionTiers: (s: string) => void;
  wallClockCapMin: string;
}) {
  const trimmed = ambitionTiers.trim();
  const parsed = Number(trimmed);
  const isValid =
    trimmed.length === 0 ||
    (Number.isInteger(parsed) && parsed >= 0 && parsed <= 20);
  const capTrimmed = wallClockCapMin.trim();
  const capParsed = Number(capTrimmed);
  const capIsShort =
    capTrimmed.length > 0 &&
    Number.isFinite(capParsed) &&
    capParsed < 60;
  const showShortCapWarning =
    isValid && trimmed.length > 0 && parsed > 0 && capIsShort;
  return (
    <Field
      label="Ambition tier cap (Unit 34)"
      hint={
        trimmed.length === 0
          ? "Empty → inherits AMBITION_RATCHET_ENABLED env (today's default off). 0 = stop on first 'all met'. 1–20 = climb that many tiers; each tier asks the planner for a more ambitious next contract once the current one is satisfied."
          : isValid
            ? parsed === 0
              ? "Disabled — runner stops on first 'all met'."
              : `Will climb up to ${parsed} tier${parsed === 1 ? "" : "s"} (re-asks the planner for a harder next contract on each all-met).`
            : "Out of range — enter an integer between 0 and 20, or leave empty to inherit the env default."
      }
    >
      <input
        value={ambitionTiers}
        onChange={(e) => setAmbitionTiers(e.target.value)}
        placeholder="(default: env)"
        className={`input font-mono ${!isValid ? "border-rose-500" : ""}`}
        inputMode="numeric"
      />
      {showShortCapWarning ? (
        <div className="text-xs text-amber-300 mt-1">
          Tier-climb usually needs &gt;1 hr to make a meaningful second
          tier — your wall-clock cap of {capParsed} min may stop the run
          before the climb fires.
        </div>
      ) : null}
    </Field>
  );
}

// Unit 63b: one-click preset chip that fills both the wall-clock cap
// and ambition-tier inputs with the multi-hour autonomous defaults.
// Mirrors the "+ Deliver every README feature + research" chip pattern
// — same styling, same single-click semantics.
function MultiHourPresetChip({
  setWallClockCapMin,
  setAmbitionTiers,
}: {
  setWallClockCapMin: (s: string) => void;
  setAmbitionTiers: (s: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        setWallClockCapMin(String(MULTI_HOUR_CAP_MIN));
        setAmbitionTiers(String(MULTI_HOUR_TIERS));
      }}
      title="Click to fill the wall-clock cap and ambition-tier inputs above with the multi-hour autonomous defaults"
      className="inline-block text-xs px-3 py-1 rounded-full bg-ink-700 hover:bg-ink-600 text-ink-300 hover:text-ink-100 border border-ink-600 transition"
    >
      + Multi-hour autonomous ({Math.round(MULTI_HOUR_CAP_MIN / 60)}h, {MULTI_HOUR_TIERS} tiers)
    </button>
  );
}

// Unit 63 follow-on: Units 58 (dedicated auditor + auditor model),
// 59 (specialized workers), and 60 (critic ensemble) all shipped
// server-side but had no UI exposure. Grouped here as "agent
// topology" because each one changes how many specialized roles
// the run spawns or how many lanes a critic verdict takes.
function BlackboardAgentTopology({
  dedicatedAuditor,
  setDedicatedAuditor,
  auditorModel,
  setAuditorModel,
  specializedWorkers,
  setSpecializedWorkers,
  criticEnsemble,
  setCriticEnsemble,
  fallbackModel,
}: {
  dedicatedAuditor: boolean;
  setDedicatedAuditor: (v: boolean) => void;
  auditorModel: string;
  setAuditorModel: (s: string) => void;
  specializedWorkers: boolean;
  setSpecializedWorkers: (v: boolean) => void;
  criticEnsemble: boolean;
  setCriticEnsemble: (v: boolean) => void;
  fallbackModel: string;
}) {
  return (
    <div className="space-y-2">
      <ToggleField
        label="Dedicated auditor agent (Unit 58)"
        checked={dedicatedAuditor}
        onChange={setDedicatedAuditor}
        hint="Off: planner doubles as auditor (1 less process). On: spawn a separate agent at index N+1 that ONLY runs audit prompts. Frees the planner to focus on todo authorship; useful for multi-hour runs where audit + planning compete for the same session context."
      />
      <Field
        label="Auditor model override (Unit 58)"
        hint={
          !dedicatedAuditor
            ? `Only used when 'Dedicated auditor agent' is enabled above. Recommended for blackboard: ${BLACKBOARD_DEFAULT_AUDITOR_MODEL} (heavier verifier-style model).`
            : auditorModel.trim().length === 0
              ? `Empty → falls back to the planner model (or main Model: ${fallbackModel}). Recommended for blackboard: ${BLACKBOARD_DEFAULT_AUDITOR_MODEL}.`
              : `Auditor agent will run on ${auditorModel.trim()}.`
        }
      >
        <input
          value={auditorModel}
          onChange={(e) => setAuditorModel(e.target.value.slice(0, 200))}
          placeholder={`(blackboard recommended: ${BLACKBOARD_DEFAULT_AUDITOR_MODEL})`}
          className="input font-mono"
          disabled={!dedicatedAuditor}
        />
      </Field>
      <ToggleField
        label="Specialized workers (Unit 59)"
        checked={specializedWorkers}
        onChange={setSpecializedWorkers}
        hint="Off: all workers share one prompt. On: assign each worker a role (correctness / simplicity / consistency) so identical model weights produce distinct priors when claiming the same todo class. Keeps blackboard topology, no extra processes."
      />
      <ToggleField
        label="Critic ensemble (Unit 60)"
        checked={criticEnsemble}
        onChange={setCriticEnsemble}
        hint="Off: one critic verdict per commit (substance lane only). On: three parallel verdicts (substance / regression / consistency); reject if ANY lane rejects. Catches more busywork at the cost of 3× critic prompts per commit."
      />
    </div>
  );
}

// Unit 63 follow-on: Unit 36's outside-world UI URL. Server-side
// MCP_PLAYWRIGHT_ENABLED=true is also required for the swarm-ui
// agent to actually capture; the hint surfaces this so users don't
// silently get file-only audits when they expected a snapshot.
function BlackboardUiUrl({
  uiUrl,
  setUiUrl,
}: {
  uiUrl: string;
  setUiUrl: (s: string) => void;
}) {
  const trimmed = uiUrl.trim();
  let isValid = trimmed.length === 0;
  if (!isValid) {
    try {
      // eslint-disable-next-line no-new
      new URL(trimmed);
      isValid = true;
    } catch {
      isValid = false;
    }
  }
  return (
    <Field
      label="Live app URL for outside-world auditor (Unit 36)"
      hint={
        trimmed.length === 0
          ? "Optional. When set, the auditor's swarm-ui agent navigates here and captures the live page accessibility tree as primary evidence for user-visible criteria. Requires MCP_PLAYWRIGHT_ENABLED=true server-side AND `npm install -g @playwright/mcp` on the box. Without those the audit silently falls back to file-only evaluation."
          : isValid
            ? `Auditor will browser_navigate to ${trimmed} on each audit invocation.`
            : "Not a valid URL — must include scheme (e.g. http://localhost:3000)."
      }
    >
      <input
        value={uiUrl}
        onChange={(e) => setUiUrl(e.target.value.slice(0, 2000))}
        placeholder="http://localhost:3000"
        className={`input font-mono ${!isValid ? "border-rose-500" : ""}`}
        inputMode="url"
      />
    </Field>
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
