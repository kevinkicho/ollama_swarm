import { useState } from "react";
import {
  BlackboardAdvanced,
  BlackboardModelOverrides,
  BlackboardWallClockCap,
  BlackboardAmbitionTiers,
  BlackboardAgentTopology,
  BlackboardUiUrl,
  BlackboardVerifyCommand,
  type CouncilContractPref,
} from "./BlackboardSettings";
import { RoleDiffAdvanced, type SwarmRoleWeb } from "./RoleDiffSettings";
import { DebateJudgeAdvanced } from "./DebateJudgeSettings";
// T199 (2026-05-04): per-tier model pickers for round-robin / OW-Deep / MoA.
import {
  RoundRobinDispositionModels,
  OwDeepTierModels,
  MoaProposerModels,
} from "./PerTierModelPicker";

export type PresetStatus = "active" | "planned";

// Task #138 (revised): per-preset directive behavior. Surfaces under
// the User Directive textarea so users know upfront whether the
// preset will act on what they type.
//   "honored"          — directive shapes the run (blackboard only today)
//   "uses-proposition" — directive ignored, but the preset has a
//                         separate Proposition field that plays the
//                         same role (debate-judge)
//   "ignored"          — discussion-only preset; the directive has
//                         no slot and is dropped on the floor
export type DirectiveBehavior = "honored" | "uses-proposition" | "ignored";

export interface SwarmPreset {
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
  directive: DirectiveBehavior;
}

// Unit 63: one-click "Multi-hour autonomous" preset. Single source of
// truth so the chip's button label stays in sync if these defaults
// shift later. 8 h cap + 5 tiers matches the north-star scenario in
// docs/autonomous-productivity.md.
const MULTI_HOUR_CAP_MIN = 480;
const MULTI_HOUR_TIERS = 5;

// Task #138 (revised): hint text + visual badge for the User Directive
// field. Per-preset behavior is fixed in the preset spec; this just
// renders it in a consistent, scannable shape so the user knows what
// the swarm will actually do with what they type.
export function directiveHintFor(preset: SwarmPreset): string {
  switch (preset.directive) {
    case "honored":
      // 2026-05-02 (round-robin improvement #5): per-preset copy now
      // that round-robin also honors the directive. Blackboard uses it
      // for its planner contract; round-robin frames every disposition
      // turn + final synthesis around it; MoA seeds the proposers with
      // it. All three accept empty for "preset's default behavior".
      switch (preset.id) {
        case "blackboard":
          return "This preset will use the directive. Blackboard shapes its auto-generated contract from turn 1 around what you write here. Leave empty for the planner's own read of repo gaps. Max 4000 chars.";
        case "round-robin":
          return "This preset will use the directive. Every disposition turn and the final synthesis are framed around it. Leave empty for open-ended discussion of the repo. Max 4000 chars.";
        case "role-diff":
          return "This preset will use the directive. Setting it auto-selects a BUILD role catalog (Researcher/Designer/Implementer/Tester/Reviewer/Documenter/Devil's-advocate); each role writes a `### MY DELIVERABLE` block which is composed into a deliverable.md. Leaving empty falls back to the audit catalog (Architect/Tester/Security/Perf/Docs/Deps/Devil's-advocate). Max 4000 chars.";
        case "map-reduce":
          return "This preset will use the directive. Mappers search their isolated slice for findings relevant to the directive (off-topic slices may report 'no relevant findings — that's fine'); reducer answers the directive across all mapper findings. Leave empty for an open repo sweep. Max 4000 chars.";
        case "council":
          return "This preset will use the directive. Each agent drafts independently in Round 1 (peers hidden), then reveals + revises with explicit KEEP/CHANGE ownership of their `### MY POSITION` against drift. Synthesis preserves dissent via a Minority report. Leave empty for open-ended council on the repo. Max 4000 chars.";
        case "orchestrator-worker":
          return "This preset will use the directive. Lead decomposes the directive into worker subtasks; workers report findings relevant to the directive (off-topic subtasks may report 'no relevant findings'); lead's synthesis answers the directive. Leave empty for a generic repo audit. Max 4000 chars.";
        case "orchestrator-worker-deep":
          return "This preset will use the directive. Top orchestrator decomposes the directive into one coarse sub-question per mid-lead; mid-leads decompose into worker subtasks; everything synthesizes upward into a directive answer. Leave empty for a tiered repo sweep. Max 4000 chars.";
        case "moa":
          return "This preset will use the directive. Each proposer drafts an independent answer to it; the aggregator synthesizes them. Leave empty for the proposers' own read of the repo. Max 4000 chars.";
        case "debate-judge":
          return "This preset will use the directive. If you leave the Proposition (Advanced) field empty, the judge auto-derives a sharp PRO/CON proposition from your directive at run start. Debaters see directive as broader context; implementer's nextAction file edits target the directive. Set both for full control. Max 4000 chars.";
        default:
          return "This preset will use the directive to shape the run. Leave empty for the preset's default behavior. Max 4000 chars.";
      }
    case "uses-proposition":
      return "This preset ignores the directive — but it has a separate Proposition field below that plays the same role. Type your debate prompt there.";
    case "ignored":
      return "This preset analyzes the repo as-is and ignores the directive. Pick Blackboard, Round-robin, Role-diff, Map-reduce, Council, OW, OW-Deep, MoA, or Debate-judge if you want the swarm to drive toward what you type.";
  }
}

export function DirectiveBadge({ preset }: { preset: SwarmPreset }) {
  const cls =
    preset.directive === "honored"
      ? "bg-emerald-900/40 border-emerald-700/50 text-emerald-200"
      : preset.directive === "uses-proposition"
        ? "bg-sky-900/40 border-sky-700/50 text-sky-200"
        : "bg-ink-800 border-ink-700 text-ink-400";
  const label =
    preset.directive === "honored"
      ? "✓ honored by this preset"
      : preset.directive === "uses-proposition"
        ? "↳ ignored — debate-judge uses Proposition instead"
        : "✕ ignored — analysis-only preset";
  return (
    <div
      className={`mb-1.5 inline-block text-[11px] uppercase tracking-wider px-2 py-0.5 rounded border ${cls}`}
    >
      {label}
    </div>
  );
}

// Unit 63b: one-click preset chip that fills both the wall-clock cap
// and ambition-tier inputs with the multi-hour autonomous defaults.
// Mirrors the "+ Deliver every README feature + research" chip pattern
// — same styling, same single-click semantics.
export function MultiHourPresetChip({
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

// Unit 32: wrapper for the per-preset Advanced Settings section.
// Renders nothing for presets with no knobs today (round-robin,
// council, orchestrator-worker, map-reduce, stigmergy) — future
// units can add branches as they surface new knobs.
export function PresetAdvancedSettings(props: {
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
  verifyCommand: string;
  setVerifyCommand: (s: string) => void;
  // T199 (2026-05-04): per-tier model state for the open-weights-
  // parallelism value prop. Three groups, one per opt-in preset.
  agentCount: number;
  // Round-robin disposition models
  dispositionCriticModel: string;
  setDispositionCriticModel: (v: string) => void;
  dispositionSynthesizerModel: string;
  setDispositionSynthesizerModel: (v: string) => void;
  dispositionGapFinderModel: string;
  setDispositionGapFinderModel: (v: string) => void;
  dispositionBuilderModel: string;
  setDispositionBuilderModel: (v: string) => void;
  // OW-Deep tier models
  orchestratorModel: string;
  setOrchestratorModel: (v: string) => void;
  midLeadModel: string;
  setMidLeadModel: (v: string) => void;
  owDeepWorkerModel: string;
  setOwDeepWorkerModel: (v: string) => void;
  // MoA per-proposer models
  moaProposerModels: readonly string[];
  setMoaProposerModelAt: (idx: number, value: string) => void;
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
    verifyCommand,
    setVerifyCommand,
    agentCount,
    dispositionCriticModel,
    setDispositionCriticModel,
    dispositionSynthesizerModel,
    setDispositionSynthesizerModel,
    dispositionGapFinderModel,
    setDispositionGapFinderModel,
    dispositionBuilderModel,
    setDispositionBuilderModel,
    orchestratorModel,
    setOrchestratorModel,
    midLeadModel,
    setMidLeadModel,
    owDeepWorkerModel,
    setOwDeepWorkerModel,
    moaProposerModels,
    setMoaProposerModelAt,
  } = props;

  // T199 (2026-05-04): expanded the gate to include round-robin,
  // OW-Deep, and MoA — each gets a per-tier model picker.
  const hasAdvanced =
    presetId === "role-diff" ||
    presetId === "blackboard" ||
    presetId === "debate-judge" ||
    presetId === "round-robin" ||
    presetId === "orchestrator-worker-deep" ||
    presetId === "moa";
  if (!hasAdvanced) return null;

  const label = (() => {
    switch (presetId) {
      case "role-diff":
        return "Advanced settings — role catalog";
      case "blackboard":
        return "Advanced settings — contract, models, caps, agent topology, live URL";
      case "debate-judge":
        return "Advanced settings — proposition";
      // T199: per-tier model pickers for the open-weights-parallelism
      // value prop. Each preset's section just shows the picker.
      case "round-robin":
        return "Advanced settings — disposition-tuned models (T193)";
      case "orchestrator-worker-deep":
        return "Advanced settings — per-tier models (T196)";
      case "moa":
        return "Advanced settings — per-proposer models (T196)";
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
              <BlackboardVerifyCommand
                verifyCommand={verifyCommand}
                setVerifyCommand={setVerifyCommand}
              />
            </>
          ) : null}
          {presetId === "debate-judge" ? (
            <DebateJudgeAdvanced
              proposition={proposition}
              setProposition={setProposition}
            />
          ) : null}
          {/* T199 (2026-05-04): per-tier model pickers. Each renders
            * the relevant variant of PerTierModelPicker. Substrate
            * ships in T193 (round-robin disposition models) + T196
            * (OW-Deep tier models + MoA per-proposer). */}
          {presetId === "round-robin" ? (
            <RoundRobinDispositionModels
              fallbackModel={fallbackModel}
              critic={dispositionCriticModel}
              synthesizer={dispositionSynthesizerModel}
              gapFinder={dispositionGapFinderModel}
              builder={dispositionBuilderModel}
              setCritic={setDispositionCriticModel}
              setSynthesizer={setDispositionSynthesizerModel}
              setGapFinder={setDispositionGapFinderModel}
              setBuilder={setDispositionBuilderModel}
            />
          ) : null}
          {presetId === "orchestrator-worker-deep" ? (
            <OwDeepTierModels
              fallbackModel={fallbackModel}
              orchestratorModel={orchestratorModel}
              midLeadModel={midLeadModel}
              workerModel={owDeepWorkerModel}
              setOrchestratorModel={setOrchestratorModel}
              setMidLeadModel={setMidLeadModel}
              setWorkerModel={setOwDeepWorkerModel}
            />
          ) : null}
          {presetId === "moa" ? (
            <MoaProposerModels
              fallbackModel={fallbackModel}
              proposerCount={agentCount}
              proposerModels={moaProposerModels}
              setProposerModel={setMoaProposerModelAt}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
