// 2026-05-02 (onboarding lever #3): banner that warns when the
// currently-selected Ollama model isn't pulled locally + offers a
// one-click swap to one that IS available.
//
// First-run trap closed: a fresh user with `ollama serve` running
// locally typically has 1-2 models pulled (whatever they pulled last).
// The configured DEFAULT_MODEL (glm-5.1:cloud) requires Ollama-via-
// cloud-partner setup. If they hit Start with the default, they get
// a 404 with no clear "your model isn't available" signal — they
// bounce. This banner makes the gap visible and actionable.
//
// Renders nothing when:
//   - Models still loading (no flash)
//   - Model field is empty (other UI handles that)
//   - Selected model IS in the available list
//   - provider !== "ollama" (paid providers have hardcoded model lists,
//     no equivalent "is it pulled" question)

import { useAvailableModels } from "../../hooks/useAvailableModels";
import type { Provider } from "../../../../shared/src/providers";

export function ModelAvailabilityBanner({
  selectedModel,
  provider,
  onSwap,
}: {
  selectedModel: string;
  provider: Provider;
  onSwap: (model: string) => void;
}) {
  const { models, loading, error } = useAvailableModels();
  if (provider !== "ollama") return null;
  if (loading) return null;
  if (!selectedModel.trim()) return null;
  // Don't render the banner when Ollama itself is unreachable — the
  // existing MissingModelsHint handles that case downstream and we
  // don't want two error-shaped UIs at once.
  if (error || models.length === 0) return null;
  if (models.includes(selectedModel)) return null;

  const fallback = models[0];
  return (
    <div className="bg-amber-950 border border-amber-700 rounded-lg p-3 flex items-center gap-3">
      <div className="flex-1 text-sm">
        <div className="font-semibold text-amber-300">
          Model <code className="bg-ink-900 px-1 rounded">{selectedModel}</code> isn't pulled locally
        </div>
        <div className="text-xs text-amber-200/80 mt-1">
          Your Ollama install has {models.length} model{models.length === 1 ? "" : "s"} pulled.
          The current selection will 404 when the swarm tries to use it.
        </div>
      </div>
      <button
        type="button"
        onClick={() => onSwap(fallback)}
        className="px-3 py-2 rounded bg-amber-700 hover:bg-amber-600 text-white text-sm whitespace-nowrap"
      >
        Use {fallback}
      </button>
    </div>
  );
}
