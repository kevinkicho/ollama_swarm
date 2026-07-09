import type { Provider } from "@ollama-swarm/shared/providers";
import type { ProviderProbeStatus } from "../types";
import { TipKvRow, TIP_HEADER_CLASS } from "./setup/FormattedTipContent";

const PROVIDER_LABELS: Record<Provider, string> = {
  ollama: "Ollama",
  "ollama-cloud": "Ollama Cloud",
  anthropic: "Anthropic",
  openai: "OpenAI",
  opencode: "OpenCode",
};

export interface SystemProbeDetails {
  provider: Provider;
  model: string;
  status: ProviderProbeStatus;
  toolsEnabled?: boolean;
  lastProbeAt?: number;
  lastProbeMs?: number;
  lastError?: string;
  modelCount?: number;
  endpoint?: string;
}

export function SystemProbeTipContent({ details }: { details: SystemProbeDetails }) {
  const statusAccent = probeStatusAccent(details.status);
  const fields: {
    label: string;
    value: string;
    mono?: boolean;
    accent?: string;
  }[] = [
    { label: "Provider", value: PROVIDER_LABELS[details.provider] ?? details.provider },
    { label: "Status", value: probeStatusLabel(details.status), accent: statusAccent },
    { label: "Model", value: details.model, mono: true },
  ];

  if (details.toolsEnabled !== undefined) {
    fields.push({ label: "File tools", value: details.toolsEnabled ? "enabled" : "disabled" });
  }
  if (details.modelCount !== undefined) {
    fields.push({ label: "Models", value: String(details.modelCount) });
  }
  if (details.lastProbeMs !== undefined) {
    fields.push({ label: "Latency", value: `${details.lastProbeMs}ms`, mono: true });
  }
  if (details.lastProbeAt !== undefined) {
    fields.push({ label: "Checked", value: formatProbeAge(details.lastProbeAt) });
  }
  if (details.endpoint) {
    fields.push({ label: "Endpoint", value: details.endpoint, mono: true });
  }
  if (details.lastError) {
    fields.push({ label: "Error", value: details.lastError, accent: "text-red-300" });
  }

  return (
    <div className="space-y-1.5 whitespace-nowrap">
      <div className={TIP_HEADER_CLASS}>Provider health</div>
      <div className="space-y-1">
        {fields.map((f) => (
          <TipKvRow
            key={f.label}
            field={{ label: f.label, value: f.value, mono: f.mono, accent: f.accent }}
          />
        ))}
      </div>
      <p className="text-[9px] text-ink-500 opacity-70 pt-0.5">Retest runs a new live check</p>
    </div>
  );
}

function probeStatusLabel(status: ProviderProbeStatus): string {
  switch (status) {
    case "ok":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "rate_limited":
      return "Rate limited";
    case "down":
      return "Down";
    case "unconfigured":
      return "Unconfigured";
    case "idle":
    default:
      return "Probing…";
  }
}

function probeStatusAccent(status: ProviderProbeStatus): string {
  switch (status) {
    case "ok":
      return "text-emerald-400";
    case "degraded":
    case "rate_limited":
    case "idle":
      return "text-amber-400";
    case "down":
      return "text-red-400";
    default:
      return "text-ink-400";
  }
}

function formatProbeAge(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 8) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}