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
  ollama: "Ollama",
  "ollama-cloud": "Ollama Cloud",
  anthropic: "Anthropic",
  openai: "OpenAI",
  opencode: "OpenCode",
};

/** Compact dropdown labels (sidebar) — same names, no abbreviations. */
const PROVIDER_COMPACT_LABELS: Record<Provider, string> = {
  ollama: "Ollama",
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
  opencode: "OPENCODE_API_KEY or OPENCODE_GO_API_KEY",
};

function providerAvailable(p: Provider, status: ProvidersStatus): boolean {
  if (p === "ollama" || p === "ollama-cloud") return true;
  if (p === "opencode") return status.providers?.opencode?.available ?? false;
  return status.providers ? status.providers[p].available : true;
}

export function ProviderTabs({
  value,
  onChange,
  status,
  variant = "tabs",
}: {
  value: Provider;
  onChange: (next: Provider) => void;
  status: ProvidersStatus;
  /** `compact` = dropdown for narrow sidebars; `tabs` = horizontal tab row (wraps). */
  variant?: "tabs" | "compact";
}) {
  if (variant === "compact") {
    return (
      <select
        aria-label="AI provider"
        value={value}
        onChange={(e) => onChange(e.target.value as Provider)}
        className="w-full min-w-0 max-w-full text-[11px] bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-ink-200 focus:outline-none focus:border-emerald-600"
      >
        {PROVIDER_ORDER.map((p) => {
          const available = providerAvailable(p, status);
          const envVar = PROVIDER_ENV_VAR[p];
          return (
            <option key={p} value={p} disabled={!available}>
              {PROVIDER_COMPACT_LABELS[p]}
              {!available ? " (no key)" : ""}
              {envVar && !available ? ` — ${envVar}` : ""}
            </option>
          );
        })}
      </select>
    );
  }

  return (
    <div
      role="tablist"
      aria-label="AI provider"
      className="flex flex-wrap gap-1 bg-ink-900 border border-ink-700 rounded p-1 min-w-0"
    >
      {PROVIDER_ORDER.map((p) => {
        const label = PROVIDER_LABELS[p];
        // Ollama (local) and Ollama Cloud are "available" whenever the
        // local install responds — for cloud, the local Ollama proxies
        // :cloud models to ollama.com when an account is configured.
        // Paid providers gate on env-set API key.
        const available = providerAvailable(p, status);
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
              "shrink-0 px-2 py-1.5 rounded text-[11px] font-medium transition-colors whitespace-nowrap",
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
