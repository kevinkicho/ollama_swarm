import { useState } from "react";
import { copyText } from "../utils/copyText";

// Unit 56: extracted from SwarmView so AgentPanel and the topbar can
// share one click-to-copy chip implementation. Shows `<label> <short>`
// with the full value as the tooltip; clicking copies the full value
// to clipboard and briefly flashes a checkmark (✓ on success, ✗ on
// failure). Uses the copyText shim which falls back to execCommand for
// non-secure contexts (Kevin's WSL-IP URLs).
export function CopyChip({
  label,
  value,
  short,
}: {
  label: string;
  value: string;
  short: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const onClick = async () => {
    const ok = await copyText(value);
    setState(ok ? "copied" : "failed");
    window.setTimeout(() => setState("idle"), 1200);
  };
  return (
    <button
      onClick={onClick}
      title={`${label}: ${value}  (click to copy)`}
      className="inline-flex items-baseline gap-1.5 hover:text-ink-200 hover:bg-ink-800/70 rounded px-1.5 py-0.5 border border-transparent hover:border-ink-700 transition"
    >
      <span className="text-ink-500">{label}</span>
      <span>{short}</span>
      <span
        className={`text-[10px] w-2 ${
          state === "copied" ? "text-emerald-400" : state === "failed" ? "text-red-400" : ""
        }`}
      >
        {state === "copied" ? "✓" : state === "failed" ? "✗" : ""}
      </span>
    </button>
  );
}
