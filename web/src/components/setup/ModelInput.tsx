// #288: free-text input with a <datalist> autocomplete of models the
// local Ollama install actually has pulled. Used everywhere the
// SetupForm asks for a model id (top-level Model field, blackboard
// per-role overrides, TopologyGrid per-row overrides).
//
// Phase 4 of #314: optional `provider` prop. When provider="anthropic"
// or provider="openai", the autocomplete switches to the hardcoded
// model list from shared/src/providers.ts (no /api/tags equivalent
// for paid providers). When omitted or "ollama", behavior is the
// historical Ollama-tags datalist.
//
// Behavior:
//   - Free text always works; user can type any model id.
//   - Datalist surfaces the right per-provider candidates.
//   - When Ollama returns 0 models AND provider is ollama, the
//     MissingModelsHint renders a single line with `ollama pull`
//     instructions. Hidden for paid providers (no equivalent action).
//   - Each ModelInput needs a unique listId across the page (browser
//     requirement) — useId provides one.

import { useId } from "react";
import { useAvailableModels } from "../../hooks/useAvailableModels";
import {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  type Provider,
} from "../../../../shared/src/providers";

export function ModelInput({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel,
  provider = "ollama",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  provider?: Provider;
}) {
  const ollamaModels = useAvailableModels().models;
  const listId = useId();
  const candidates =
    provider === "anthropic"
      ? ANTHROPIC_MODELS
      : provider === "openai"
        ? OPENAI_MODELS
        : ollamaModels;
  return (
    <>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        placeholder={placeholder}
        className={className ?? "input font-mono"}
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
      />
      <datalist id={listId}>
        {candidates.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  );
}

// Renders a single inline hint above the model-input section when
// Ollama returned zero models. Suggests pulling the recommended
// default. Returns null when models are present (no clutter for the
// happy path) and also when the fetch is still in-flight (avoids
// flashing the hint then hiding it on first paint). Phase 4: only
// shown when provider is ollama; paid providers have no equivalent.
export function MissingModelsHint({
  recommendedModel,
  provider = "ollama",
}: {
  recommendedModel: string;
  provider?: Provider;
}) {
  const { models, loading, error } = useAvailableModels();
  if (provider !== "ollama") return null;
  if (loading || models.length > 0) return null;
  const cmd = `ollama pull ${recommendedModel}`;
  return (
    <div className="rounded border border-amber-700/60 bg-amber-900/20 text-amber-200 text-xs px-3 py-2">
      <div className="font-medium mb-1">No Ollama models found.</div>
      <div className="text-amber-200/80">
        Run{" "}
        <code className="bg-ink-900/80 px-1.5 py-0.5 rounded font-mono">{cmd}</code>{" "}
        to install the recommended default, then refresh this page.
      </div>
      {error ? (
        <div className="text-amber-200/60 mt-1">Ollama unreachable: {error}</div>
      ) : null}
    </div>
  );
}
