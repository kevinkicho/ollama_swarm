// #290: rich-info hover tooltip for the Preset field. Appears next to
// the field label as an "ⓘ" target; on hover renders a portal-based
// card with the currently-selected preset's full metadata (summary,
// agent range, recommended count, recommended model, directive
// behavior, status). Complements the per-option `title` attribute on
// the select dropdown — that gives a one-line hint while picking;
// this gives the full picture for the selected one.

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SwarmPreset } from "./PresetExtras";

function directiveText(p: SwarmPreset): string {
  switch (p.directive) {
    case "honored":
      return "Directive HONORED — your User Directive shapes the run.";
    case "uses-proposition":
      return "Directive ignored — uses Proposition field instead.";
    case "ignored":
      return "Directive ignored — analysis-only preset.";
  }
}

export function PresetTooltip({ preset }: { preset: SwarmPreset }) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const onEnter = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
  };
  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={onEnter}
        onMouseLeave={() => setPos(null)}
        className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full border border-ink-600 text-ink-400 hover:text-ink-200 hover:border-ink-400 cursor-help text-[10px] font-mono leading-none align-middle"
        aria-label={`About ${preset.label}`}
      >
        ?
      </span>
      {pos
        ? createPortal(
            <div
              className="fixed z-50 bg-ink-900 border border-ink-600 rounded-md p-3 shadow-xl pointer-events-none text-xs"
              style={{ top: pos.top, left: pos.left, maxWidth: 380 }}
            >
              <div className="text-ink-100 font-semibold mb-1">{preset.label}</div>
              <p className="text-ink-300 mb-2 leading-snug">{preset.summary}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                <dt className="text-ink-500 uppercase tracking-wider">Agents</dt>
                <dd className="text-ink-200 font-mono">
                  {preset.min === preset.max
                    ? `${preset.min} (fixed)`
                    : `${preset.min}–${preset.max} (recommended ${preset.recommended})`}
                </dd>
                <dt className="text-ink-500 uppercase tracking-wider">Model</dt>
                <dd className="text-ink-200 font-mono">{preset.recommendedModel}</dd>
                <dt className="text-ink-500 uppercase tracking-wider">Status</dt>
                <dd className="text-ink-200">
                  {preset.status === "active" ? "Active" : "Coming soon"}
                </dd>
                <dt className="text-ink-500 uppercase tracking-wider">Directive</dt>
                <dd
                  className={
                    preset.directive === "honored"
                      ? "text-emerald-300"
                      : preset.directive === "uses-proposition"
                        ? "text-sky-300"
                        : "text-ink-400"
                  }
                >
                  {directiveText(preset)}
                </dd>
              </dl>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
