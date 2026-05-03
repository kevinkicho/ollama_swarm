// 2026-05-03: real <select> dropdown for picking a model from the
// per-provider discovery list — replaces the prior <input list> +
// <datalist> pattern in the top-level Model field. The datalist
// pattern hid the choice in autocomplete; users reported not
// realizing the dropdown existed. A real <select> advertises the
// choices.
//
// Escape hatch: when the user wants to type a model id that
// discovery didn't return (a brand-new release, a private fine-tune,
// a less-common Ollama tag), they pick "Custom..." which swaps the
// select for a text input. Free-text path is preserved.
//
// Per-row TopologyGrid + per-role Blackboard overrides continue to
// use the ModelInput (datalist) component — those grid cells need
// the compact text-input style and per-cell discovery is overkill.
// This component is for the top-level Model field where the
// discovery-aware dropdown adds the most value.

import { useState } from "react";
import { useAvailableModels } from "../../hooks/useAvailableModels";
import type { Provider } from "../../../../shared/src/providers";

const CUSTOM_SENTINEL = "__custom__";

export function ModelSelect({
  value,
  onChange,
  provider,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  provider: Provider;
  ariaLabel?: string;
}) {
  const { models, loading, error, source } = useAvailableModels(provider);
  // "Custom" mode is sticky: once the user picks Custom we keep the
  // text input visible (even if the typed value happens to match a
  // dropdown option) until they explicitly switch back.
  const [customMode, setCustomMode] = useState(false);
  // When discovery hasn't returned anything yet, render plain text input
  // so the form stays usable while loading.
  const hasOptions = !loading && models.length > 0;
  const valueIsKnown = hasOptions && models.includes(value);
  // If the user typed a value that doesn't match any option AND we're
  // not in customMode, force customMode on so the text input shows the
  // typed value instead of the select silently dropping it.
  const showCustom = customMode || (hasOptions && value.length > 0 && !valueIsKnown);

  if (!hasOptions || showCustom) {
    return (
      <div className="space-y-1">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={loading ? "Loading models…" : "Type a model id"}
          className="input font-mono"
          autoComplete="off"
          spellCheck={false}
          aria-label={ariaLabel}
        />
        {hasOptions ? (
          <button
            type="button"
            onClick={() => {
              setCustomMode(false);
              onChange(models[0]);
            }}
            className="text-xs text-ink-500 hover:text-ink-300"
          >
            ← Use dropdown ({models.length} model{models.length === 1 ? "" : "s"} available)
          </button>
        ) : null}
        {error && !loading ? (
          <div className="text-xs text-amber-400">Discovery error: {error}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <select
        value={valueIsKnown ? value : models[0]}
        onChange={(e) => {
          const next = e.target.value;
          if (next === CUSTOM_SENTINEL) {
            setCustomMode(true);
            // Pre-fill custom input with the current value so the user
            // doesn't lose what was selected.
            return;
          }
          onChange(next);
        }}
        className="input font-mono"
        aria-label={ariaLabel}
      >
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value={CUSTOM_SENTINEL}>— Custom (type a model id) —</option>
      </select>
      <DiscoverySourceHint source={source} count={models.length} provider={provider} />
    </div>
  );
}

// Inline hint showing where the dropdown options came from. Tells
// the user "your account has live access to N models" vs "showing
// fallback list because no API key" so they can self-diagnose.
function DiscoverySourceHint({
  source,
  count,
  provider,
}: {
  source: "ollama-tags" | "discovery" | "fallback" | null;
  count: number;
  provider: Provider;
}) {
  if (source === null) return null;
  if (source === "ollama-tags") {
    return (
      <div className="text-[11px] text-ink-500">
        {count} model{count === 1 ? "" : "s"} from your local Ollama install
      </div>
    );
  }
  if (source === "discovery") {
    return (
      <div className="text-[11px] text-emerald-500/70">
        {count} live model{count === 1 ? "" : "s"} from {provider === "anthropic" ? "Anthropic" : "OpenAI"} API
      </div>
    );
  }
  // fallback: for paid providers means discovery failed (no key or
  // upstream error). For ollama-cloud "fallback" is the EXPECTED source
  // — Ollama Cloud has no per-user discovery endpoint, the catalog is
  // global (sourced from ollama.com/search?c=cloud) so we always show
  // it as the curated list with no warning tone.
  if (provider === "ollama-cloud") {
    return (
      <div className="text-[11px] text-ink-500">
        {count} model{count === 1 ? "" : "s"} from the Ollama Cloud catalog
      </div>
    );
  }
  return (
    <div className="text-[11px] text-amber-400/80">
      {count} fallback model{count === 1 ? "" : "s"} ({provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} not set — list may be stale)
    </div>
  );
}
