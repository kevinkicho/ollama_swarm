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
// Also used in TopologyGrid per-row overrides (with allowDefault).
// Blackboard per-role Advanced overrides still use ModelInput (datalist).

import { useState } from "react";
import { useAvailableModels } from "../../hooks/useAvailableModels";
import type { Provider } from "../../../../shared/src/providers";

const CUSTOM_SENTINEL = "__custom__";

export function ModelSelect({
  value,
  onChange,
  provider,
  ariaLabel,
  compact = false,
  allowDefault = false,
  defaultLabel = "(use default)",
}: {
  value: string;
  onChange: (next: string) => void;
  provider: Provider;
  ariaLabel?: string;
  /** Smaller typography for narrow sidebars. */
  compact?: boolean;
  /** When true, empty value is a first-class option (topology overrides). */
  allowDefault?: boolean;
  defaultLabel?: string;
}) {
  const inputCls = compact
    ? "input font-mono text-[11px] min-w-0 max-w-full w-full"
    : "input font-mono min-w-0 max-w-full w-full";
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
  const showCustom =
    customMode || (hasOptions && value.length > 0 && !valueIsKnown && !(allowDefault && value === ""));

  const discoveryTitle = getDiscoverySourceTitle(source, models.length, provider);

  if (!hasOptions || showCustom) {
    return (
      <div className="space-y-1">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={loading ? "Loading models…" : "Type a model id"}
          className={inputCls}
          autoComplete="off"
          spellCheck={false}
          aria-label={ariaLabel}
          title={discoveryTitle ?? undefined}
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
        {/* Only surface discovery errors when we have no models to offer.
            Offline catalog fallbacks already keep the dropdown usable. */}
        {error && !loading && models.length === 0 ? (
          <div className="text-xs text-amber-400" title={error}>
            Discovery error: {error}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <select
        value={
          allowDefault && value === ""
            ? ""
            : valueIsKnown
              ? value
              : models[0]
        }
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
        className={inputCls}
        aria-label={ariaLabel}
        title={discoveryTitle ?? undefined}
      >
        {allowDefault ? (
          <option value="">{defaultLabel}</option>
        ) : null}
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value={CUSTOM_SENTINEL}>— Custom (type a model id) —</option>
      </select>
    </div>
  );
}

/** Hover title for the model dropdown — where the option list came from. */
function getDiscoverySourceTitle(
  source: "ollama-tags" | "discovery" | "fallback" | null,
  count: number,
  provider: Provider,
): string | null {
  if (source === null) return null;
  const n = `${count} model${count === 1 ? "" : "s"}`;
  if (source === "ollama-tags") {
    return `${n} from your local Ollama install`;
  }
  if (source === "discovery") {
    if (provider === "anthropic") return `${n} live from Anthropic API`;
    if (provider === "openai") return `${n} live from OpenAI API`;
    if (provider === "opencode") return `${n} live from OpenCode Go API`;
    return `${n} live from provider API`;
  }
  if (provider === "ollama-cloud") {
    return `${n} from the Ollama Cloud catalog`;
  }
  if (provider === "opencode") {
    return `${n} from the OpenCode catalog`;
  }
  const key = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  return `${n} fallback (${key} not set — list may be stale)`;
}