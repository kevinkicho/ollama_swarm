// #288: free-text input with a <datalist> autocomplete of models the
// local Ollama install actually has pulled. Used everywhere the
// SetupForm asks for a model id (top-level Model field, blackboard
// per-role overrides, TopologyGrid per-row overrides).
//
// Behavior:
//   - Free text always works; user can type any model id.
//   - The datalist surfaces locally-available models so first-time
//     users get a one-click pick instead of memorizing valid strings.
//   - When Ollama returns 0 models, MissingModelsHint renders a single
//     line above the field group instructing the user to pull one.
//   - Each ModelInput needs a unique listId across the page (browser
//     requirement) — caller-provided so render order is deterministic.

import { useId } from "react";
import { useAvailableModels } from "../../hooks/useAvailableModels";

export function ModelInput({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const { models } = useAvailableModels();
  const listId = useId();
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
        {models.map((m) => (
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
// flashing the hint then hiding it on first paint).
export function MissingModelsHint({
  recommendedModel,
}: {
  recommendedModel: string;
}) {
  const { models, loading, error } = useAvailableModels();
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
