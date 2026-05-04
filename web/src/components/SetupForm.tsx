import { useState } from "react";
import { useSwarm } from "../state/store";
import { PreflightPreview } from "./PreflightPreview";
// 2026-05-03 (UX win #8): StartConfirmModal removed from the flow.
// The inline PreflightPreview already shows the same info, and the
// Start button label flips to "Resume run" when alreadyPresent — so
// the modal's confirmation step became redundant. Keeping the file
// in the repo for now so re-introduction (if needed) is one import
// away. import { StartConfirmModal } from "./StartConfirmModal";
import { usePreflight } from "../hooks/usePreflight";
import { Field } from "./setup/SharedFields";
import { STARTER_DIRECTIVES } from "./setup/StarterDirectives";
import { ModelAvailabilityBanner } from "./setup/ModelAvailabilityBanner";
import { ModelInput, MissingModelsHint } from "./setup/ModelInput";
import { ModelSelect } from "./setup/ModelSelect";
import { ProviderTabs } from "./setup/ProviderTabs";
import { useProviders } from "../hooks/useProviders";
import { detectProvider, type Provider } from "../../../shared/src/providers";
import {
  WallClockEstimate,
  estimateWallClockSeconds,
  formatDurationSeconds,
} from "./setup/WallClockEstimate";
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
import {
  loadRecentRuns,
  saveRecentRun,
  shortRepoLabel,
  type RecentRun,
} from "./setup/RecentRuns";
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
    // 2026-05-02 (improvement #5): no longer "neutral baseline" — every
    // turn rotates through Critic/Synthesizer/Gap-finder/Builder, the
    // user directive shapes seed + each turn + final synthesis.
    summary: "Structured deliberation. N agents take turns, each turn a different disposition (Critic/Synthesizer/Gap-finder/Builder). Lead synthesizes a directive answer at the end.",
    min: 2,
    max: 8,
    recommended: 3,
    recommendedModel: MODEL_REASONING,
    status: "active",
    directive: "honored",
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
    // 2026-05-02 (improvement #2+#4): with a directive, becomes a
    // BUILD team (Researcher/Designer/Implementer/Tester/Reviewer/
    // Documenter/Devil's-advocate) that produces a portable
    // deliverable.md. Without one, falls back to the original audit
    // catalog (Architect/Tester/Security/Perf/...).
    summary: "Specialist team. With a directive, agents become Researcher/Designer/Implementer/Tester/Reviewer/Documenter/Devil's-advocate and produce a deliverable.md. Without one, falls back to a 7-lens repo audit.",
    min: 3,
    max: 8,
    recommended: 5,
    recommendedModel: MODEL_REASONING,
    status: "active",
    directive: "honored",
  },
  {
    id: "map-reduce",
    label: "Map-reduce over repo",
    // 2026-05-02 (improvement #1+#2): with a directive becomes a
    // parallel-coverage answerer ("find everything in this repo that
    // bears on X, in parallel"). Without one, falls back to the
    // original "tell me about this repo" sweep.
    summary: "Parallel coverage. With a directive, mappers search their slice for findings relevant to it (off-topic slices report 'no relevant findings'); reducer answers the directive. Without one, mappers describe their slice and reducer synthesizes a project picture.",
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
    directive: "honored",
  },
  {
    id: "council",
    label: "Council (parallel drafts + reconcile)",
    // 2026-05-02 (improvement #1+#2+#3+#4): each agent ends every turn
    // with a `### MY POSITION` block; Round-2+ requires explicit
    // KEEP/CHANGE ownership against prior position; synthesis includes
    // a Minority report; deliverable surfaces per-agent positions
    // side-by-side. Honors directive (drafters answer it; rubric +
    // synthesis frame around it).
    summary: "Independent parallel drafts + reveal/revise. Each agent commits to a `### MY POSITION` per round; Round-2+ must explicitly KEEP or CHANGE prior position. Synthesis preserves dissent via a Minority report. Honors directive.",
    min: 3,
    max: 8,
    recommended: 4,
    // All N drafters need actual angles; coding-tier produces
    // near-identical drafts → no diversity gain.
    recommendedModel: MODEL_REASONING,
    status: "active",
    directive: "honored",
  },
  {
    id: "orchestrator-worker",
    label: "Orchestrator–worker hierarchy",
    // 2026-05-02 (OW directive lever): with directive set, lead
    // decomposes the directive into worker subtasks; workers report
    // findings RELEVANT to the directive (with off-topic valve);
    // synthesis answers the directive. Without a directive, falls
    // back to "tell me about this repo" via N lenses.
    summary: "Lead decomposes work for parallel workers, then synthesizes. With a directive, lead decomposes IT into worker subtasks; workers find directive-relevant evidence; synthesis answers the directive. Without one, falls back to a generic repo audit.",
    min: 2,
    max: 8,
    recommended: 4,
    // Single-model preset today — pick orchestrator's tier. Same
    // Unit 65 candidate as map-reduce.
    recommendedModel: MODEL_REASONING,
    status: "active",
    directive: "honored",
  },
  {
    id: "orchestrator-worker-deep",
    label: "Orchestrator–worker hierarchy (3-tier)",
    // 2026-05-02 (OW-Deep directive lever): top orchestrator
    // decomposes the directive into one coarse sub-question per
    // mid-lead; mid-leads decompose those into worker subtasks;
    // workers execute toward the directive; everything synthesizes
    // upward to a directive answer.
    summary: "3-tier OW for high agent counts. With a directive, orchestrator decomposes it across mid-leads; mid-leads dispatch directive-relevant subtasks to their workers; everything synthesizes upward to a directive answer. Without one, falls back to a tiered repo sweep.",
    // Floor at 4 (1 orchestrator + 1 mid-lead + 2 workers). Cap at 30
    // because past that the orchestrator's mid-lead pool exceeds 8 again
    // and the design rationale (no tier sees > ~8 reports) breaks.
    min: 4,
    max: 30,
    recommended: 8,
    recommendedModel: MODEL_REASONING,
    status: "active",
    directive: "honored",
  },
  {
    id: "debate-judge",
    label: "Debate + judge",
    // 2026-05-03 (debate-judge directive lever): with directive set,
    // judge auto-derives a sharp PRO/CON proposition; debaters argue
    // it with directive as broader context; implementer's nextAction
    // file edits target the directive. Proposition input still works
    // for power users who want to control the debate framing directly.
    summary: "PRO vs CON debate (3 agents fixed). Judge auto-derives a debatable proposition from your directive; implementer's nextAction file edits target the directive. Optional Proposition (Advanced) lets you set the debate framing directly.",
    min: 3,
    max: 3,
    recommended: 3,
    // All three roles need higher-reasoning. Heterogeneous-judge
    // (PRO/CON on one model, JUDGE on another) is a Unit 65
    // candidate — bias mitigation gain isn't huge.
    recommendedModel: MODEL_REASONING,
    status: "active",
    directive: "honored",
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
  {
    id: "moa",
    label: "Mixture of Agents (MoA)",
    summary: "N proposers each draft independently (peer-hidden, parallel). One aggregator synthesizes their drafts. Reproducibly beats single-large-model on reasoning benchmarks using only small open-weights models.",
    min: 2,
    max: 8,
    recommended: 5,
    // Aggregator does the heavy synthesis lift; reasoning-tier helps.
    // Proposers can be coding-tier (fast independent drafts).
    recommendedModel: MODEL_REASONING,
    status: "active",
    directive: "honored",
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
  if (provider === "ollama-cloud") {
    if (status.loading) return "Checking key status…";
    const hasKey = status.providers?.["ollama-cloud"]?.hasKey;
    return hasKey
      ? "Ollama Cloud. Models hosted on ollama.com; reads OLLAMA_API_KEY from server env."
      : "Ollama Cloud. Local install proxies :cloud models to ollama.com — set OLLAMA_API_KEY for direct calls.";
  }
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
  if (provider === "ollama-cloud") return "Pick from the Ollama Cloud catalog. Reasoning tier (glm/deepseek/nemotron/kimi) at the top.";
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
  // T199 (2026-05-04): per-tier model state for the open-weights-
  // parallelism value prop. Three groups, one per opt-in preset:
  //
  // Round-robin disposition models (4 slots — Critic/Synthesizer/
  // Gap-finder/Builder). Empty = falls back to top-level Model.
  const [dispositionCriticModel, setDispositionCriticModel] = useState("");
  const [dispositionSynthesizerModel, setDispositionSynthesizerModel] = useState("");
  const [dispositionGapFinderModel, setDispositionGapFinderModel] = useState("");
  const [dispositionBuilderModel, setDispositionBuilderModel] = useState("");
  // OW-Deep per-tier models (3 slots — Orchestrator/Mid-leads/Workers).
  // workerModel is reused across blackboard + OW-Deep + MoA but here
  // it's the per-tier worker tier, so a separate state slot.
  const [orchestratorModel, setOrchestratorModel] = useState("");
  const [midLeadModel, setMidLeadModel] = useState("");
  const [owDeepWorkerModel, setOwDeepWorkerModel] = useState("");
  // MoA per-proposer model array (variable N — sized by agentCount).
  // Empty entries fall back to moaProposerModel → cfg.model.
  const [moaProposerModels, setMoaProposerModels] = useState<string[]>([]);
  const setMoaProposerModelAt = (idx: number, value: string) => {
    setMoaProposerModels((prev) => {
      const out = [...prev];
      while (out.length <= idx) out.push("");
      out[idx] = value;
      return out;
    });
  };
  const [busy, setBusy] = useState(false);
  const setError = useSwarm((s) => s.setError);
  const reset = useSwarm((s) => s.reset);
  // 2026-05-03 (UX win #8): preflight state lifted from PreflightPreview.
  // Drives the inline preview AND the sticky Start button's label
  // ("Resume run" when alreadyPresent) + disabled-ness (when blocker).
  // The previous focus-grabbing StartConfirmModal is gone — the
  // inline preview + button-label change ARE the confirmation gate.
  const preflight = usePreflight(repoUrl, parentPath);
  const preflightBlocked = preflight.state?.blocker === "not-git-repo";
  const isResume = preflight.state?.alreadyPresent === true && !preflightBlocked;

  // 2026-05-03 (UX win #2): hide First-time starters by default for
  // returning users. localStorage flag set on first form submit so
  // first-paint always shows starters, but subsequent visits hide
  // them behind a one-line "Show starters" affordance.
  const [showStarters, setShowStarters] = useState(() => {
    try {
      return window.localStorage.getItem("ollama-swarm:starters-dismissed") !== "true";
    } catch {
      return true;
    }
  });
  const dismissStarters = () => {
    setShowStarters(false);
    try {
      window.localStorage.setItem("ollama-swarm:starters-dismissed", "true");
    } catch {
      // localStorage unavailable (private mode) — non-fatal, just won't persist.
    }
  };
  // 2026-05-03 (UX win #3): Topology grid collapsed by default. Most
  // users want preset defaults; an 8-row grid for a knob 90% don't
  // touch is the largest section on screen. Collapsed state shows
  // a one-line summary chip ("3 agents · all on glm-5.1") + Edit btn.
  const [topologyOpen, setTopologyOpen] = useState(false);
  // 2026-05-03 (UX win #7): recently-used run configurations from
  // localStorage. Updated on successful submit. Click a chip to
  // re-fill (repoUrl + parentPath + preset + directive).
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>(() => loadRecentRuns());
  const refillFromRecent = (r: RecentRun) => {
    setRepoUrl(r.repoUrl);
    setParentPath(r.parentPath);
    setUserDirective(r.directive);
    // Use the same onPresetChange machinery as the starter chips so
    // topology + model pick up the preset's defaults consistently.
    const fakeEvent = {
      target: { value: r.presetId },
    } as unknown as React.ChangeEvent<HTMLSelectElement>;
    onPresetChange(fakeEvent);
  };

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
      // T199 (2026-05-04): per-tier model state for the open-weights-
      // parallelism value prop. Round-robin disposition models +
      // OW-Deep tier models + MoA per-proposer models. OUTSIDE the
      // blackboard branch so each preset's state is emitted in its
      // own block. Each only emits if the matching preset is selected.
      if (preset.id === "round-robin") {
        const dm: Record<string, string> = {};
        if (dispositionCriticModel.trim()) dm.critic = dispositionCriticModel.trim();
        if (dispositionSynthesizerModel.trim()) dm.synthesizer = dispositionSynthesizerModel.trim();
        if (dispositionGapFinderModel.trim()) dm["gap-finder"] = dispositionGapFinderModel.trim();
        if (dispositionBuilderModel.trim()) dm.builder = dispositionBuilderModel.trim();
        if (Object.keys(dm).length > 0) presetSpecific.dispositionModels = dm;
      }
      if (preset.id === "orchestrator-worker-deep") {
        const om = orchestratorModel.trim();
        const ml = midLeadModel.trim();
        const wm = owDeepWorkerModel.trim();
        if (om) presetSpecific.orchestratorModel = om;
        if (ml) presetSpecific.midLeadModel = ml;
        if (wm) presetSpecific.workerModel = wm;
      }
      if (preset.id === "moa") {
        const cleaned = moaProposerModels
          .slice(0, agentCount)
          .map((m) => m.trim())
          .filter((m, i, a) => i < a.length); // keep all slots, even empty
        if (cleaned.some((m) => m.length > 0)) {
          presetSpecific.moaProposerModels = cleaned;
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
      // 2026-05-03 (UX win #7): persist for the recently-used row.
      // Only fires on a successful POST (HTTP 200) so cancelled / failed
      // starts don't pollute the list. Capped at 3 entries inside
      // saveRecentRun + deduped by (repoUrl + presetId).
      setRecentRuns(saveRecentRun({
        repoUrl,
        parentPath,
        presetId: preset.id,
        directive: userDirective,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // 2026-05-03 (UX win #8): Preflight is now passive — it runs
  // continuously via usePreflight as the user types and renders
  // inline (PreflightPreview) + drives the Start button label
  // ("Resume run") + disabled-ness (when blocker). onSubmit just
  // fires performStart; the inline preview + matching button label
  // ARE the deliberate-confirmation gate that the modal used to
  // provide. The button is disabled when blocker so the click can't
  // even fire — server-side /start is still the safety net.
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isActive || preflightBlocked) return;
    await performStart();
  };

  return (
    <>
    {/* 2026-05-03 (UX win #1 fix): keep parent at pb-12 so the
        scroller's content-box bottom = viewport bottom, which is
        where `position: sticky; bottom: 0` calculates against. The
        bottom spacer needed for the sticky CTA goes INSIDE the form
        (after the sticky div) so visual gap is preserved without
        shifting the sticky reference point. */}
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

        {/* 2026-05-02 (onboarding lever #3): warn early when the
            selected model isn't pulled, with one-click swap to a
            model that IS available. Closes the silent-404 trap a
            first-time user hits when DEFAULT_MODEL=glm-5.1:cloud
            but their local Ollama only has e.g. llama3 pulled. */}
        <ModelAvailabilityBanner
          selectedModel={model}
          provider={provider}
          onSwap={setModel}
        />

        {/* 2026-05-02 (onboarding lever #3): click-to-fill starter
            directives. First-time user sees concrete examples before
            the form, can pick one to skip the "what should I type?"
            paralysis. Each starter pre-fills repoUrl + preset +
            directive — user can still edit before submitting.
            2026-05-03 (UX win #2): hidden by default for returning
            users via localStorage; one-line "Show starters" affordance
            keeps it discoverable. */}
        {showStarters ? (
          <Section
            title="First time?"
            subtitle="Pick a starter to skip the blank-form paralysis (you can edit anything before submitting)"
          >
            <div className="grid sm:grid-cols-2 gap-3">
              {STARTER_DIRECTIVES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setRepoUrl(s.repoUrl);
                    setUserDirective(s.directive);
                    // Use the existing onPresetChange machinery so the
                    // preset switch fires its full topology + model side-
                    // effects (otherwise the form gets into a weird mid-
                    // state where presetId says "blackboard" but topology
                    // still reflects the prior preset).
                    const fakeEvent = {
                      target: { value: s.presetId },
                    } as unknown as React.ChangeEvent<HTMLSelectElement>;
                    onPresetChange(fakeEvent);
                  }}
                  className="text-left bg-ink-900 hover:bg-ink-700 border border-ink-700 rounded-lg p-3 transition-colors"
                  title={s.whyTry}
                >
                  <div className="text-sm font-semibold text-emerald-400">{s.label}</div>
                  <div className="text-xs text-ink-400 mt-1">{s.summary}</div>
                  <div className="text-[11px] text-ink-500 mt-1 truncate">
                    → {s.repoUrl.replace("https://github.com/", "")}
                  </div>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={dismissStarters}
              className="text-xs text-ink-500 hover:text-ink-300 transition-colors"
              title="Hide this section on future visits (re-shown via Show starters link below the header)"
            >
              Don't show again
            </button>
          </Section>
        ) : (
          <button
            type="button"
            onClick={() => setShowStarters(true)}
            className="text-xs text-ink-500 hover:text-ink-300 transition-colors self-start"
          >
            + Show starter directives
          </button>
        )}

        {/* 2026-05-03 (UX win #7): recently-used row. Hidden on first
            paint (empty list); appears once a user has run the form
            at least once. Click a chip to re-fill repoUrl + parentPath
            + preset + directive. Most users iterate on the same
            project — saves retyping the same repo URL + directive. */}
        {recentRuns.length > 0 ? (
          <Section
            title="Recent runs"
            subtitle="Click to re-fill the form (you can edit anything before submitting)"
          >
            <div className="flex flex-wrap gap-2">
              {recentRuns.map((r) => {
                const presetLabel = PRESETS.find((p) => p.id === r.presetId)?.label ?? r.presetId;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => refillFromRecent(r)}
                    className="text-left bg-ink-900 hover:bg-ink-700 border border-ink-700 rounded p-2 max-w-[280px] transition-colors"
                    title={`Re-fill: ${r.repoUrl} · ${presetLabel}${r.directiveSnippet ? ` · "${r.directiveSnippet}"` : ""}`}
                  >
                    <div className="text-xs text-ink-100 truncate font-mono">{shortRepoLabel(r.repoUrl)}</div>
                    <div className="text-[11px] text-ink-400 truncate">{presetLabel}</div>
                    {r.directiveSnippet ? (
                      <div className="text-[11px] text-emerald-300 truncate mt-0.5">"{r.directiveSnippet}"</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </Section>
        ) : null}

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
          {/* 2026-05-03 (UX win #8): preflight state lifted to usePreflight
              hook above; passed down here as props. Same visual output. */}
          <PreflightPreview state={preflight.state} error={preflight.error} />
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

          {/* 2026-05-03: DirectiveBadge sits inline with the User
              directive label — speaks directly to the field it
              modifies (badge state changes whether typing in the
              textarea has any effect). Earlier iteration parked it
              on the Preset selector header which was visually
              cleaner but semantically misplaced.
              2026-05-03 (later same day): all 9 active presets now
              honor directive, so the badge would always render the
              same "✓ honored" stamp. Hide it when honored to remove
              visual noise; surfaces automatically again if a future
              preset adds an "ignored" / "uses-proposition" mode.
              The directive hint (directiveHintFor) below the
              textarea still tells the user HOW each preset uses the
              directive — that's the load-bearing copy. */}
          <Field
            label="User directive (optional)"
            hint={directiveHintFor(preset)}
            labelAccessory={
              preset.directive !== "honored" ? <DirectiveBadge preset={preset} /> : undefined
            }
          >
            {/* 2026-05-03 (UX win #9): auto-resize as the user types.
                onInput resets height to "auto" then grows it to match
                scrollHeight, capped at ~280px so very long directives
                stay scrollable instead of pushing the rest of the form
                off-screen. Manual resize handle (resize: vertical) still
                works for users who want a fixed size. */}
            <textarea
              value={userDirective}
              onChange={(e) => setUserDirective(e.target.value.slice(0, 4000))}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(280, el.scrollHeight)}px`;
              }}
              placeholder="e.g., Make this project actually deliver every feature the README claims to support."
              rows={3}
              className="input"
              style={{ fontFamily: "inherit", resize: "vertical", minHeight: 60, maxHeight: 280, overflow: "auto" }}
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
            agentCount={agentCount}
            dispositionCriticModel={dispositionCriticModel}
            setDispositionCriticModel={setDispositionCriticModel}
            dispositionSynthesizerModel={dispositionSynthesizerModel}
            setDispositionSynthesizerModel={setDispositionSynthesizerModel}
            dispositionGapFinderModel={dispositionGapFinderModel}
            setDispositionGapFinderModel={setDispositionGapFinderModel}
            dispositionBuilderModel={dispositionBuilderModel}
            setDispositionBuilderModel={setDispositionBuilderModel}
            orchestratorModel={orchestratorModel}
            setOrchestratorModel={setOrchestratorModel}
            midLeadModel={midLeadModel}
            setMidLeadModel={setMidLeadModel}
            owDeepWorkerModel={owDeepWorkerModel}
            setOwDeepWorkerModel={setOwDeepWorkerModel}
            moaProposerModels={moaProposerModels}
            setMoaProposerModelAt={setMoaProposerModelAt}
          />
        </Section>

        {/* 2026-05-03: dedicated AI Provider section sitting between
            Pattern and Topology. Provider+Model used to live as a
            corner of the Run row, which read as "two equal knobs";
            lifting them into their own section makes the
            provider-then-model flow explicit. Placed BEFORE Topology
            so the per-agent grid's defaultModel reflects the user's
            chosen model. ProviderTabs (segmented control) shows
            availability per-tab inline; ModelSelect renders a real
            <select> dropdown with discovery-source hint + "Custom..."
            escape hatch for free-text. */}
        <Section title="AI Provider" subtitle="Pick a provider first; the model dropdown filters to what your account can run">
          <Field label="Provider" hint={providerHint(provider, providersStatus)}>
            <ProviderTabs
              value={provider}
              status={providersStatus}
              onChange={(next) => {
                setProvider(next);
                // Reset model so the user picks a valid one for the new
                // provider (carrying glm-5.1:cloud into a Claude run
                // would 404 on session.create). ModelSelect will
                // auto-pick the first model for the new provider once
                // discovery finishes.
                setModel("");
              }}
            />
          </Field>
          <Field label="Model" hint={modelHint(provider)}>
            <ModelSelect
              value={model}
              onChange={setModel}
              provider={provider}
              ariaLabel="Default model"
            />
          </Field>
          <MissingModelsHint recommendedModel={preset.recommendedModel} provider={provider} />
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
        </Section>

        {/* 2026-05-03 (UX win #3): Topology collapsed by default. Most
            users want preset defaults; an 8-row grid for a knob 90%
            don't touch was the largest section on screen. Collapsed
            renders a one-line summary chip with the agent count + a
            "uniform/mixed model" indicator. Click "Edit per-agent" to
            expand. */}
        <Section title="Topology" subtitle="Per-agent role + model overrides">
          {topologyOpen ? (
            <>
              <TopologyGrid
                preset={{ id: preset.id, min: preset.min, max: preset.max }}
                topology={topology}
                setTopology={onTopologyChange}
                defaultModel={model}
              />
              <button
                type="button"
                onClick={() => setTopologyOpen(false)}
                className="text-xs text-ink-500 hover:text-ink-300 transition-colors"
              >
                ▾ Collapse to summary
              </button>
            </>
          ) : (
            <TopologySummaryChip
              topology={topology}
              defaultModel={model}
              onEdit={() => setTopologyOpen(true)}
            />
          )}
        </Section>

        <Section title="Run" subtitle="Rounds + time budget">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            <div className="flex items-end">
              <WallClockEstimate
                presetId={preset.id}
                agentCount={agentCount}
                rounds={rounds}
                mainModel={model}
                wallClockCapMin={wallClockCapMin}
              />
            </div>
          </div>
        </Section>

        {/* 2026-05-03 (UX win #1): sticky Start bar at the bottom of
            the viewport. Pre-fix the user had to scroll past 5 cards
            to reach Submit AND scroll back to the Run section to see
            the wall-clock estimate. Sticky bar = always-visible
            decision + always-visible cost preview.
            Two-zone styling: a tall transparent-to-solid gradient
            FADES content into the bar from above, then a SOLID
            bg-ink-900 strip under the button row guarantees the
            content scrolling underneath doesn't bleed through and
            confuse the user. */}
        <div className="sticky bottom-0 -mx-1 z-10">
          <div className="h-6 bg-gradient-to-t from-ink-900 to-transparent pointer-events-none" />
          <div className="bg-ink-900 px-1 pb-3 pt-1 border-t border-ink-700/50">
            <div className="flex items-center gap-3">
              <div className="flex-1 text-xs text-ink-400 min-w-0 truncate" title="Pre-flight estimate based on preset shape × agentCount × rounds × per-model turn time">
                <CompactWallClockHint
                  presetId={preset.id}
                  agentCount={agentCount}
                  rounds={rounds}
                  mainModel={model}
                  wallClockCapMin={wallClockCapMin}
                />
              </div>
              <button
                type="submit"
                disabled={busy || !isActive || preflightBlocked}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-ink-600 disabled:cursor-not-allowed text-white font-medium rounded px-6 py-3 text-base transition shadow-lg whitespace-nowrap"
                title={
                  preflightBlocked
                    ? "Disabled: target path exists but is not a git repo. Edit Parent folder or delete the existing directory."
                    : isResume
                      ? "Resume the existing clone — no re-clone, no destructive operation. The inline notice in Repository above shows what state the clone is in."
                      : undefined
                }
              >
                {/* 2026-05-03 (UX win #8): label flips when preflight finds
                    an existing clone — "Resume run" makes the deliberate
                    choice explicit at click time. Replaces the prior
                    StartConfirmModal as the confirmation gate. */}
                {busy
                  ? "Starting…"
                  : !isActive
                    ? "Coming soon"
                    : preflightBlocked
                      ? "Blocked — fix path"
                      : isResume
                        ? "Resume run"
                        : "Start swarm"}
              </button>
            </div>
          </div>
        </div>

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
    {/* 2026-05-03 (UX win #8): StartConfirmModal removed — see usePreflight
        wiring above. The inline PreflightPreview + Start button label
        ("Resume run" when alreadyPresent, "Blocked — fix path" when
        blocker) replace the modal's confirmation step. */}
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

// 2026-05-03 (UX win #3): collapsed Topology summary chip. Shows the
// agent count + a "all on <model>" or "mixed models" indicator, with
// an Edit affordance to expand the full grid. Renders zero-height
// nothing when topology is empty (defensive).
function TopologySummaryChip({
  topology,
  defaultModel,
  onEdit,
}: {
  topology: Topology;
  defaultModel: string;
  onEdit: () => void;
}) {
  const agents = topology.agents;
  if (agents.length === 0) return null;
  // Determine if all agents use the same model (or fall through to
  // defaultModel). "Mixed" when any per-agent model differs from the
  // others — helps the user spot when their per-agent overrides
  // diverge from a uniform setup.
  const effectiveModels = agents.map((a) => (a.model && a.model.trim().length > 0 ? a.model.trim() : defaultModel));
  const uniqueModels = new Set(effectiveModels);
  const modelLabel =
    uniqueModels.size === 1
      ? `all on ${effectiveModels[0] || "(default model)"}`
      : `mixed models (${uniqueModels.size} distinct)`;
  // Distinct roles for the role-mix hint when more than one role
  // exists (role-diff, OW, OW-Deep, debate-judge, etc.).
  const roleSet = new Set(agents.map((a) => a.role));
  const roleHint =
    roleSet.size > 1
      ? ` · ${roleSet.size} roles (${Array.from(roleSet).slice(0, 4).join(", ")}${roleSet.size > 4 ? "…" : ""})`
      : "";
  return (
    <div className="flex items-center justify-between gap-3 bg-ink-900 border border-ink-700 rounded p-3">
      <div className="text-sm text-ink-300 min-w-0 truncate">
        <span className="font-mono text-ink-100">{agents.length} agent{agents.length === 1 ? "" : "s"}</span>
        {" · "}
        <span className="text-ink-400">{modelLabel}</span>
        <span className="text-ink-500">{roleHint}</span>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="text-xs px-3 py-1 rounded border border-ink-600 text-ink-300 hover:text-ink-100 hover:border-ink-400 transition-colors whitespace-nowrap"
        title="Expand to edit per-agent role + model overrides"
      >
        Edit per-agent ▸
      </button>
    </div>
  );
}

// 2026-05-03 (UX win #1): compact wall-clock hint shown next to the
// sticky Start button. Pulls the same estimator the full
// WallClockEstimate component uses but renders a one-line "~5m" /
// "~25m, may exceed 10m cap" output instead of the full breakdown.
// Blackboard runs (no rounds) show "~uses cap or 8h default".
function CompactWallClockHint({
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
      <span className="text-ink-400">
        ~ blackboard cap: {capValid ? `${capParsed} min` : "8 h default"}
      </span>
    );
  }
  const seconds = estimateWallClockSeconds(presetId, agentCount, rounds, mainModel);
  if (seconds === null) {
    return <span className="text-ink-500">~ pre-flight estimate unavailable</span>;
  }
  const cap = wallClockCapMin.trim();
  const capMinParsed = Number(cap);
  const capValid = cap.length > 0 && Number.isFinite(capMinParsed) && capMinParsed >= 1;
  const capSec = capValid ? Math.round(capMinParsed * 60) : null;
  let color = "text-ink-300";
  let warn = "";
  if (capSec !== null) {
    const ratio = seconds / capSec;
    if (ratio > 1.2) {
      color = "text-rose-300";
      warn = ` · likely > ${formatDurationSeconds(capSec)} cap`;
    } else if (ratio > 0.8) {
      color = "text-amber-300";
      warn = ` · close to ${formatDurationSeconds(capSec)} cap`;
    }
  }
  return (
    <span className={color}>
      ~ {formatDurationSeconds(seconds)} estimated
      {warn}
    </span>
  );
}
