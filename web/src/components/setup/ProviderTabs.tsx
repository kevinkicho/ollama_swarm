// 2026-05-03: segmented provider control. Replaces the Provider
// <select> dropdown with side-by-side tabs that visually communicate
// "pick a provider" as a primary decision (rather than a corner of
// the Run row).
//
// Each tab labels itself with availability state inline (matches the
// prior dropdown's "Anthropic — no key" pattern). Disabled tabs
// can't be clicked. Active tab gets emerald accent.
//
// 2026-05-03: added "Ollama Cloud" as a UI-distinct 4th provider.
// Routes the same as plain Ollama under the hood (the local Ollama
// install proxies `:cloud`-suffixed models to ollama.com), but the
// dedicated tab lets users pick from the curated cloud catalog
// without scrolling local + cloud models in one mixed list.

import type { Provider } from "../../../../shared/src/providers";
import type { useProviders } from "../../hooks/useProviders";

type ProvidersStatus = ReturnType<typeof useProviders>;

const PROVIDER_LABELS: Record<Provider, string> = {
  ollama: "Ollama (local)",
  "ollama-cloud": "Ollama Cloud",
  anthropic: "Anthropic",
  openai: "OpenAI",
  opencode: "OpenCode",
};

const PROVIDER_ORDER: readonly Provider[] = ["ollama", "ollama-cloud", "opencode", "anthropic", "openai"];

// Env-var name to surface in the disabled-tab tooltip. Ollama and Ollama Cloud
// are always enabled (local install handles auth). OpenCode detects keys from config.
const PROVIDER_ENV_VAR: Partial<Record<Provider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  opencode: "OPENCODE_GO_API_KEY / OPENCODE_ZEN_API_KEY",
};

export function ProviderTabs({
  value,
  onChange,
  status,
}: {
  value: Provider;
  onChange: (next: Provider) => void;
  status: ProvidersStatus;
}) {
  return (
    <div role="tablist" aria-label="AI provider" className="flex gap-1 bg-ink-900 border border-ink-700 rounded p-1">
      {PROVIDER_ORDER.map((p) => {
        const label = PROVIDER_LABELS[p];
        // Ollama (local) and Ollama Cloud are "available" whenever the
        // local install responds — for cloud, the local Ollama proxies
        // :cloud models to ollama.com when an account is configured.
        // Paid providers gate on env-set API key.
        const available =
          p === "ollama" || p === "ollama-cloud"
            ? true
            : p === "opencode"
              ? (status.providers?.opencode?.available ?? false)
              : status.providers
                ? status.providers[p].available
                : true; // optimistic while loading
        const noKey = !available;
        const active = value === p;
        const envVar = PROVIDER_ENV_VAR[p];
        return (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={noKey}
            onClick={() => onChange(p)}
            className={[
              "flex-1 px-3 py-2 rounded text-sm font-medium transition-colors",
              active
                ? "bg-emerald-600 text-white shadow-sm"
                : noKey
                  ? "text-ink-600 cursor-not-allowed"
                  : "text-ink-300 hover:bg-ink-800 hover:text-ink-100",
            ].join(" ")}
            title={noKey && envVar ? `${label} disabled — set ${envVar} in .env` : undefined}
          >
            {label}
            {noKey ? " — no key" : ""}
          </button>
        );
      })}
    </div>
  );
}
