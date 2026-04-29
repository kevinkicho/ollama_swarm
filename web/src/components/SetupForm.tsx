import { useState } from "react";
import { useSwarm } from "../state/store";
import { PreflightPreview } from "./PreflightPreview";
import { StartConfirmModal } from "./StartConfirmModal";
import type { PreflightState } from "../types";
import { Field } from "./setup/SharedFields";
import { ModelInput, MissingModelsHint } from "./setup/ModelInput";
import { useProviders } from "../hooks/useProviders";
import { detectProvider, type Provider } from "../../../shared/src/providers";
import { WallClockEstimate } from "./setup/WallClockEstimate";
import {
  BlackboardHelp,
  BLACKBOARD_DEFAULT_PLANNER_MODEL,
  BLACKBOARD_DEFAULT_WORKER_MODEL,
  BLACKBOARD_DEFAULT_AUDITOR_MODEL,
  type CouncilContractPref,
} from "./setup/BlackboardSettings";
import { type SwarmRoleWeb, DEFAULT_ROLES_WEB } from "./setup/RoleDiffSettings";
import {
  PresetAdvancedSettings,
  DirectiveBadge,
  directiveHintFor,
  type SwarmPreset,
} from "./setup/PresetExtras";
import { TopologyGrid, topologyForPreset } from "./setup/TopologyGrid";
import { PresetTooltip } from "./setup/PresetTooltip";
import type { Topology } from "../../../shared/src/topology";

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
// pattern across role-diff + council).
//
// 2026-04-27: REASONING flipped again, nemotron-3-super:cloud →
// deepseek-v4-pro:cloud, per Kevin's directive after he pulled +
// verified deepseek-v4-pro is loaded.
//
// 2026-04-27 (later): REVERTED back to glm-5.1:cloud. deepseek showed
// Ollama server-traffic congestion (HTTP 503 + slow batched chunks
// that bypassed our streaming-collapsibles + emitted XML tool-call
// syntax that broke JSON parsing). glm-5.1 + nemotron stay as the
// reliable reasoning-tier pair until deepseek's serving stabilizes.
// All three models remain available via the form's free-text Model
// field. Keep constants separate so a future per-role split can
// target REASONING / CODING / VERIFIER without touching every preset.
const MODEL_REASONING = "glm-5.1:cloud";
const MODEL_CODING = "gemma4:31b-cloud";

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
    directive: "ignored",
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
    directive: "honored",
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
    directive: "ignored",
  },
  {
    id: "map-reduce",
    label: "Map-reduce over repo",
    summary: "Mappers inspect a round-robin slice of top-level entries in isolation; reducer synthesizes.",
    // Task #109: floored at 4 (1 reducer + 3 mappers). Smaller setups
    // leave one mapper with a trivially-small slice and the model
    // collapses on it (run 2bcf662f). The route-layer Zod schema also
    // enforces this, so the form's min keeps both UIs aligned.
    min: 4,
    max: 8,
    recommended: 5,
    // Single-model preset today — pick reducer's tier so synthesis
    // doesn't bottleneck. When per-role model selection ships
    // (Unit 65 candidate), swap mappers to MODEL_CODING.
    recommendedModel: MODEL_REASONING,
    status: "active",
    directive: "ignored",
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
    directive: "ignored",
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
    directive: "ignored",
  },
  {
    id: "orchestrator-worker-deep",
    label: "Orchestrator–worker hierarchy (3-tier)",
    summary: "3-tier OW for high agent counts. Agent 1 = orchestrator; ~K mid-leads; remaining are workers (~5 per mid-lead). Per cycle: top-plan → mid-plan → workers → mid-synth → top-synth.",
    // Floor at 4 (1 orchestrator + 1 mid-lead + 2 workers). Cap at 30
    // because past that the orchestrator's mid-lead pool exceeds 8 again
    // and the design rationale (no tier sees > ~8 reports) breaks.
    min: 4,
    max: 30,
    recommended: 8,
    recommendedModel: MODEL_REASONING,
    status: "active",
    directive: "ignored",
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
    directive: "uses-proposition",
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
    directive: "ignored",
  },
];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// Quick-fill text for the "Deliver README + research" chip below the
// user-directive textarea. One-click way to seed the planner with the
// directive we've been overnight-running on `kyahoofinance032926`.
const DIRECTIVE_README_AND_RESEARCH =
  "Make this project actually deliver every feature the README claims to support. Also, creatively enhance its functionalities by adding in more pipelines by conducting research online and then implement them";

// Phase 4 of #314: per-provider hint copy. Provider hint flips between
// "no key configured" warning and a one-line summary of where the
// API key gets read from. Model hint matches the autocomplete source.
function providerHint(
  provider: Provider,
  status: ReturnType<typeof useProviders>,
): string {
  if (provider === "ollama") return "Local LLM via your Ollama install. No API key needed.";
  if (status.loading) return "Checking key status…";
  const ps = status.providers?.[provider];
  if (!ps?.hasKey) {
    return provider === "anthropic"
      ? "Set ANTHROPIC_API_KEY in .env to enable Claude models."
      : "Set OPENAI_API_KEY in .env to enable GPT models.";
  }
  return provider === "anthropic"
    ? "Anthropic Claude. Reads ANTHROPIC_API_KEY from server env."
    : "OpenAI GPT. Reads OPENAI_API_KEY from server env.";
}

function modelHint(provider: Provider): string {
  if (provider === "ollama") return "Type any Ollama model id, or pick from your installed list.";
  if (provider === "anthropic") return "Pick a Claude model. Cost varies wildly — opus ≫ sonnet ≫ haiku.";
  return "Pick a GPT-5 family model. Cost: gpt-5 > mini > nano.";
}

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
  // Phase 1 of #243: topology is the new source of truth. agentCount
  // remains for WallClockEstimate + back-compat with the legacy POST
  // shape, but it's kept in sync with topology.agents.length on every
  // mutation. Initialized to the user's last-used shape for the
  // initial preset (Phase 3) — falls back to defaults if no prior.
  const [topology, setTopology] = useState<Topology>(() =>
    topologyForPreset("round-robin", 3, { lastUsed: true }),
  );
  // Model defaults to the initial preset's recommendation so the
  // form renders with a sensible Model field on first paint.
  // onPresetChange refreshes this when the user switches presets.
  const [model, setModel] = useState(PRESETS[0].recommendedModel);
  // Phase 4 of #314: provider state — derived from the model string's
  // prefix at first paint (so existing model defaults stay valid),
  // but also user-selectable via the provider dropdown. Changing the
  // provider clears `model` so the user picks a model that exists for
  // the new provider rather than carrying a now-invalid Ollama tag
  // into a Claude run.
  const [provider, setProvider] = useState<Provider>(() =>
    detectProvider(PRESETS[0].recommendedModel),
  );
  const providersStatus = useProviders();
  const [maxCostUsd, setMaxCostUsd] = useState<string>("");
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
  // #296: pre-commit verify command for blackboard worker pipeline.
  // Empty = legacy commit-without-verify behavior.
  const [verifyCommand, setVerifyCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const setError = useSwarm((s) => s.setError);
  const reset = useSwarm((s) => s.reset);
  // Set by onSubmit when preflight finds an existing clone or a
  // not-git-repo blocker; cleared by either Resume (after start
  // fires) or Cancel. Only one modal instance at a time.
  const [confirmModal, setConfirmModal] = useState<PreflightState | null>(null);

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const isActive = preset.status === "active";
  const previewClonePath = buildPreviewClonePath(repoUrl, parentPath);

  const onPresetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = PRESETS.find((p) => p.id === e.target.value);
    if (!next) return;
    setPresetId(next.id);
    const recommended = clamp(next.recommended, next.min, next.max);
    setAgentCount(recommended);
    // Match the agentCount auto-update pattern: switching presets
    // also flips the main Model to the new preset's recommendation
    // (e.g. round-robin → stigmergy lands you on MODEL_CODING).
    // User can override after.
    setModel(next.recommendedModel);
    // Regenerate the topology grid for the new preset. dedicatedAuditor
    // applies only to blackboard; pre-seed planner/worker/auditor models
    // from the existing per-role state so users don't lose what they typed.
    setTopology(
      topologyForPreset(next.id, recommended, {
        // Phase 3: prefer the user's last-used shape for this preset.
        // synthesizeTopology() is the fallback when no prior exists.
        lastUsed: true,
        dedicatedAuditor: next.id === "blackboard" ? dedicatedAuditor : undefined,
        plannerModel: next.id === "blackboard" ? plannerModel : undefined,
        workerModel: next.id === "blackboard" ? workerModel : undefined,
        auditorModel: next.id === "blackboard" ? auditorModel : undefined,
      }),
    );
  };

  // Phase 1 (#243): topology grid is the count knob now. Keep
  // agentCount mirrored so WallClockEstimate + legacy paths keep
  // working. agents.length is always the truthy value.
  const onTopologyChange = (next: Topology) => {
    setTopology(next);
    setAgentCount(next.agents.length);
  };

  // Phase 1d of #243: when the user edits the per-role model fields in
  // the Advanced section (planner/worker/auditor), propagate that into
  // every topology row matching that role. This way the Advanced
  // section behaves like a "set all planner rows to X" macro — each
  // individual row in the grid still wins for finer-grained overrides.
  // Empty value = clear the row's override (falls back to top-level
  // Model field via the same mechanism as TopologyGrid's placeholder).
  const updateRoleModel = (roles: ReadonlyArray<string>, value: string) => {
    const trimmed = value.trim();
    setTopology((t) => ({
      agents: t.agents.map((a) =>
        roles.includes(a.role)
          ? { ...a, model: trimmed.length > 0 ? trimmed : undefined }
          : a,
      ),
    }));
  };
  const setPlannerModelSync = (m: string) => {
    setPlannerModel(m);
    // "planner-tier" roles share the planner model: planner itself plus
    // orchestrator / reducer / judge in non-blackboard presets.
    updateRoleModel(["planner", "orchestrator", "reducer", "judge"], m);
  };
  const setWorkerModelSync = (m: string) => {
    setWorkerModel(m);
    updateRoleModel(
      ["worker", "mid-lead", "mapper", "drafter", "explorer", "peer", "pro", "con", "role-diff"],
      m,
    );
  };
  const setAuditorModelSync = (m: string) => {
    setAuditorModel(m);
    updateRoleModel(["auditor"], m);
  };
  // Toggling dedicatedAuditor changes the *count* (blackboard adds
  // one extra agent for the auditor when on). Resync the topology
  // rows so the grid reflects the new count without losing user
  // edits to other rows' models.
  const setDedicatedAuditorSync = (v: boolean) => {
    setDedicatedAuditor(v);
    if (preset.id !== "blackboard") return;
    setTopology(
      topologyForPreset(preset.id, agentCount, {
        dedicatedAuditor: v,
        plannerModel,
        workerModel,
        auditorModel,
      }),
    );
  };

  // Actual POST → /api/swarm/start. Called directly when preflight
  // is clean, or via StartConfirmModal's Resume callback when an
  // existing clone was detected and the user confirmed.
  const performStart = async () => {
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
        // #296: pre-commit verify command. Trimmed empty → omit (server
        // route's z.string().min(1) would otherwise reject the empty
        // string).
        const vc = verifyCommand.trim();
        if (vc.length > 0) presetSpecific.verifyCommand = vc;
        // Phase 4 of #314: per-run cost cap (USD). Empty / 0 → omit so
        // the runner runs without a cost gate (existing behavior).
        // Otherwise pass through; BlackboardRunner's cap watchdog stops
        // the run with cap:cost when sum-of-spend reaches the ceiling.
        // Ollama-only runs ignore the cap (every record costs $0).
        const costTrim = maxCostUsd.trim();
        if (costTrim.length > 0) {
          const cost = Number(costTrim);
          if (Number.isFinite(cost) && cost > 0) {
            presetSpecific.maxCostUsd = cost;
          }
        }
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
          // Phase 1 of #243: topology supersedes legacy fields server-
          // side. Always send it — the route's deriveLegacyFields()
          // re-derives agentCount + per-role models from this so the
          // user's grid choices win over the form's older inputs.
          topology,
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

  // Preflight gate: fire GET /api/swarm/preflight before POSTing.
  // If it detects an existing clone (alreadyPresent) or a not-git-
  // repo blocker, show the signup-style confirmation modal instead
  // of silently starting. Network errors on preflight fall through
  // — /start itself is still the source of truth for blockers.
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isActive) return;

    setBusy(true);
    try {
      const params = new URLSearchParams({
        repoUrl: repoUrl.trim(),
        parentPath: parentPath.trim(),
      });
      const res = await fetch(`/api/swarm/preflight?${params.toString()}`);
      if (res.ok) {
        const state = (await res.json()) as PreflightState;
        if (state.alreadyPresent || state.blocker) {
          setConfirmModal(state);
          setBusy(false);
          return;
        }
      }
    } catch {
      // Silent — fall through to the POST and let /start surface
      // any real error.
    }
    setBusy(false);

    await performStart();
  };

  return (
    <>
    <div className="h-full overflow-auto flex justify-center items-start px-6 pt-6 pb-12">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-3xl space-y-5"
        data-testid="setup-form"
      >
        <div className="bg-ink-800 border border-ink-700 rounded-lg p-5 shadow-xl">
          <h2 className="text-xl font-semibold mb-1">Start a swarm</h2>
          <p className="text-sm text-ink-400">
            Clone a GitHub repo and spawn N OpenCode agents inside it. Pick a pattern to decide how
            they collaborate.
          </p>
        </div>

        <Section title="Repository" subtitle="Where the swarm reads from + clones into">
          <div className="grid lg:grid-cols-2 gap-4">
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
                  ? `Will clone into ${previewClonePath}`
                  : "Repo is cloned into a subfolder named after the repo (e.g. is-odd)."
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
          </div>
          <PreflightPreview repoUrl={repoUrl} parentPath={parentPath} />
        </Section>

        <Section title="Pattern" subtitle="How the agents collaborate">
          <div>
            <div className="text-xs uppercase tracking-wide text-ink-400 mb-1 flex items-center">
              Preset
              <PresetTooltip preset={preset} />
            </div>
            <select
              value={presetId}
              onChange={onPresetChange}
              className="input"
              title={preset.summary}
            >
              {PRESETS.map((p) => (
                <option
                  key={p.id}
                  value={p.id}
                  title={`${p.summary}${p.status === "planned" ? " — coming soon" : ""}`}
                >
                  {p.label}
                  {p.status === "planned" ? " (coming soon)" : ""}
                </option>
              ))}
            </select>
            <div className="text-xs text-ink-400 mt-1">
              {isActive
                ? preset.summary
                : `${preset.summary} — not yet implemented; picking this disables Start.`}
            </div>
          </div>

          {preset.id === "blackboard" ? <BlackboardHelp /> : null}

          <Field
            label="User directive (optional)"
            hint={directiveHintFor(preset)}
          >
            <DirectiveBadge preset={preset} />
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
            setPlannerModel={setPlannerModelSync}
            workerModel={workerModel}
            setWorkerModel={setWorkerModelSync}
            fallbackModel={model}
            wallClockCapMin={wallClockCapMin}
            setWallClockCapMin={setWallClockCapMin}
            ambitionTiers={ambitionTiers}
            setAmbitionTiers={setAmbitionTiers}
            dedicatedAuditor={dedicatedAuditor}
            setDedicatedAuditor={setDedicatedAuditorSync}
            auditorModel={auditorModel}
            setAuditorModel={setAuditorModelSync}
            specializedWorkers={specializedWorkers}
            setSpecializedWorkers={setSpecializedWorkers}
            criticEnsemble={criticEnsemble}
            setCriticEnsemble={setCriticEnsemble}
            uiUrl={uiUrl}
            setUiUrl={setUiUrl}
            verifyCommand={verifyCommand}
            setVerifyCommand={setVerifyCommand}
          />
        </Section>

        <Section title="Topology" subtitle="Per-agent role + model overrides">
          {/* Phase 1 (#243): topology grid is the count knob — owns +/−,
              per-row Role + Model. agentCount stays mirrored from
              topology.agents.length so WallClockEstimate keeps working. */}
          <TopologyGrid
            preset={{ id: preset.id, min: preset.min, max: preset.max }}
            topology={topology}
            setTopology={onTopologyChange}
            defaultModel={model}
          />
        </Section>

        <Section title="Run" subtitle="Rounds, default model, time budget">
          <MissingModelsHint recommendedModel={preset.recommendedModel} provider={provider} />
          <div className="grid grid-cols-3 gap-4">
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
            <Field label="Provider" hint={providerHint(provider, providersStatus)}>
              <select
                className="input"
                value={provider}
                onChange={(e) => {
                  const next = e.target.value as Provider;
                  setProvider(next);
                  // Reset model so the user picks a valid one for the
                  // new provider (carrying glm-5.1:cloud into a Claude
                  // run would 404 on session.create).
                  setModel("");
                }}
                aria-label="Provider"
              >
                <option value="ollama">Ollama (local)</option>
                <option
                  value="anthropic"
                  disabled={providersStatus.providers ? !providersStatus.providers.anthropic.available : false}
                >
                  Anthropic{providersStatus.providers && !providersStatus.providers.anthropic.available ? " — no key" : ""}
                </option>
                <option
                  value="openai"
                  disabled={providersStatus.providers ? !providersStatus.providers.openai.available : false}
                >
                  OpenAI{providersStatus.providers && !providersStatus.providers.openai.available ? " — no key" : ""}
                </option>
              </select>
            </Field>
            <Field label="Model" hint={modelHint(provider)}>
              <ModelInput value={model} onChange={setModel} ariaLabel="Default model" provider={provider} />
            </Field>
          </div>
          {provider !== "ollama" ? (
            <Field label="Max cost ($USD)" hint="Per-run cap for paid providers. Stops the run with cap:cost when reached. Ollama-only runs ignore this.">
              <input
                type="number"
                min={0}
                step={0.10}
                value={maxCostUsd}
                onChange={(e) => setMaxCostUsd(e.target.value)}
                placeholder="e.g. 0.50"
                className="input"
              />
            </Field>
          ) : null}

          <WallClockEstimate
            presetId={preset.id}
            agentCount={agentCount}
            rounds={rounds}
            mainModel={model}
            wallClockCapMin={wallClockCapMin}
          />
        </Section>

        <button
          type="submit"
          disabled={busy || !isActive}
          className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-ink-600 disabled:cursor-not-allowed text-white font-medium rounded px-4 py-3 text-base transition shadow-lg"
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
    {confirmModal ? (
      <StartConfirmModal
        state={confirmModal}
        onResume={() => {
          setConfirmModal(null);
          void performStart();
        }}
        onCancel={() => setConfirmModal(null)}
      />
    ) : null}
    </>
  );
}

// Visual section wrapper. Each section is its own bordered card so the
// form reads as scannable groups instead of one tall stack — fixes the
// overflow-into-scroll-purgatory issue when many fields are visible.
function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-ink-800 border border-ink-700 rounded-lg p-5 shadow-xl space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-ink-100 uppercase tracking-wider">{title}</h3>
        {subtitle ? <p className="text-xs text-ink-400 mt-0.5">{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}
