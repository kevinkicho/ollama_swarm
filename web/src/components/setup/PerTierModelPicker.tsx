// T199 (2026-05-04): per-tier model picker for the open-weights-
// parallelism value prop. Three preset variants share this component:
//
//   - round-robin: per-disposition (Critic/Synthesizer/Gap-finder/Builder)
//   - OW-Deep: per-tier (Orchestrator/Mid-leads/Workers)
//   - MoA: per-proposer (an array of N model slots)
//
// Substrate (cfg fields) shipped in T193 + T196; this is the form
// surface. Each row uses ModelInput for autocomplete consistency
// with the top-level Model field. Empty string in any slot means
// "fall back to cfg.model" — the runner handles the fallback.

import { ModelInput } from "./ModelInput";

export interface PerTierModelPickerProps {
  /** Display label shown above the picker. */
  label: string;
  /** Short hint below the label (e.g. "Critic/Gap-finder benefit
   *  from reasoning-tier; Builder/Synthesizer benefit from coding-tier"). */
  hint?: string;
  /** List of tier slots — name + current value + setter + optional
   *  per-row hint (e.g. "Critic" + "(reasoning-tier recommended)"). */
  tiers: ReadonlyArray<{
    name: string;
    value: string;
    setValue: (v: string) => void;
    rowHint?: string;
  }>;
  /** Fallback shown as ghost-text in each row's input. */
  fallbackModel: string;
}

export function PerTierModelPicker(props: PerTierModelPickerProps) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-medium text-ink-200">{props.label}</div>
        {props.hint ? (
          <div className="text-xs text-ink-500 mt-0.5">{props.hint}</div>
        ) : null}
      </div>
      <div className="space-y-1.5">
        {props.tiers.map((t) => (
          <div key={t.name} className="flex items-center gap-2">
            <div className="w-32 shrink-0 text-xs text-ink-300">
              {t.name}
              {t.rowHint ? (
                <div className="text-[10px] text-ink-600 leading-tight">
                  {t.rowHint}
                </div>
              ) : null}
            </div>
            <div className="flex-1">
              <ModelInput
                value={t.value}
                onChange={t.setValue}
                placeholder={`(fallback: ${props.fallbackModel})`}
                ariaLabel={`${props.label} — ${t.name}`}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="text-[10px] text-ink-600">
        Empty slot = falls back to the top-level Model. Plays to the
        open-weights-parallelism value prop — different tiers can use
        different models without spawning more agents.
      </div>
    </div>
  );
}

// Convenience wrappers for the three preset variants. Each takes a
// state shape + setters and renders the right tier list.

export function RoundRobinDispositionModels(props: {
  fallbackModel: string;
  critic: string;
  synthesizer: string;
  gapFinder: string;
  builder: string;
  setCritic: (v: string) => void;
  setSynthesizer: (v: string) => void;
  setGapFinder: (v: string) => void;
  setBuilder: (v: string) => void;
}) {
  return (
    <PerTierModelPicker
      label="Disposition-tuned models (T193)"
      hint="Each disposition can use a different model. Critic/Gap-finder benefit from reasoning-tier; Builder/Synthesizer benefit from coding-tier."
      fallbackModel={props.fallbackModel}
      tiers={[
        {
          name: "Critic",
          value: props.critic,
          setValue: props.setCritic,
          rowHint: "(reasoning-tier)",
        },
        {
          name: "Synthesizer",
          value: props.synthesizer,
          setValue: props.setSynthesizer,
          rowHint: "(coding-tier)",
        },
        {
          name: "Gap-finder",
          value: props.gapFinder,
          setValue: props.setGapFinder,
          rowHint: "(reasoning-tier)",
        },
        {
          name: "Builder",
          value: props.builder,
          setValue: props.setBuilder,
          rowHint: "(coding-tier)",
        },
      ]}
    />
  );
}

export function OwDeepTierModels(props: {
  fallbackModel: string;
  orchestratorModel: string;
  midLeadModel: string;
  workerModel: string;
  setOrchestratorModel: (v: string) => void;
  setMidLeadModel: (v: string) => void;
  setWorkerModel: (v: string) => void;
}) {
  return (
    <PerTierModelPicker
      label="Per-tier models (T196)"
      hint="Orchestrator (strategy) → Mid-leads (tactics) → Workers (implementation). Reasoning-tier at top, coding-tier at bottom is the canonical pattern."
      fallbackModel={props.fallbackModel}
      tiers={[
        {
          name: "Orchestrator",
          value: props.orchestratorModel,
          setValue: props.setOrchestratorModel,
          rowHint: "(strategy)",
        },
        {
          name: "Mid-leads",
          value: props.midLeadModel,
          setValue: props.setMidLeadModel,
          rowHint: "(tactics)",
        },
        {
          name: "Workers",
          value: props.workerModel,
          setValue: props.setWorkerModel,
          rowHint: "(implementation)",
        },
      ]}
    />
  );
}

// MoA per-proposer picker. N slots driven by `proposerCount`; the
// caller maintains a string[] of length proposerCount.
export function MoaProposerModels(props: {
  fallbackModel: string;
  proposerCount: number;
  proposerModels: readonly string[];
  setProposerModel: (idx: number, value: string) => void;
}) {
  // Pad / trim to proposerCount so the form always renders the right
  // number of slots even if the underlying state hasn't synced.
  const padded: string[] = [];
  for (let i = 0; i < props.proposerCount; i++) {
    padded.push(props.proposerModels[i] ?? "");
  }
  return (
    <PerTierModelPicker
      label={`Per-proposer models (T196) — ${props.proposerCount} proposers`}
      hint="N DIFFERENT small models proposing > N copies of one model. Heterogeneous proposers were the original Together AI MoA insight."
      fallbackModel={props.fallbackModel}
      tiers={padded.map((value, idx) => ({
        name: `Proposer ${idx + 1}`,
        value,
        setValue: (v: string) => props.setProposerModel(idx, v),
      }))}
    />
  );
}
