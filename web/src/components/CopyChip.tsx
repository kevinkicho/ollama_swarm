import { useState } from "react";

// Unit 56: extracted from SwarmView so AgentPanel and the topbar can
// share one click-to-copy chip implementation. Shows `<label> <short>`
// with the full value as the tooltip; clicking copies the full value
// to clipboard and briefly flashes a checkmark. Silently no-ops if
// the clipboard API isn't available (insecure context / older browsers).
export function CopyChip({
  label,
  value,
  short,
}: {
  label: string;
  value: string;
  short: string;
}) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // no-op: clipboard unavailable
    }
  };
  return (
    <button
      onClick={onClick}
      title={`${label}: ${value}  (click to copy)`}
      className="inline-flex items-baseline gap-1.5 hover:text-ink-200 hover:bg-ink-800/70 rounded px-1.5 py-0.5 border border-transparent hover:border-ink-700 transition"
    >
      <span className="text-ink-500">{label}</span>
      <span>{short}</span>
      <span className="text-emerald-400 text-[10px] w-2">{copied ? "✓" : ""}</span>
    </button>
  );
}
