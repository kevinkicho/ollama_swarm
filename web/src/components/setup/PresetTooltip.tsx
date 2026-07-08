// Rich hover tooltip for swarm preset metadata (list items + optional ⓘ target).

import type { ReactNode } from "react";
import { InfoTip } from "./InfoTip";
import {
  FormattedTipContent,
  TipKvRow,
  type TipKvField,
} from "./FormattedTipContent";
import type { DirectiveBehavior, SwarmPreset } from "./PresetExtras";

function directiveShort(directive: DirectiveBehavior): string {
  switch (directive) {
    case "honored":
      return "honored — shapes the run";
    case "uses-proposition":
      return "ignored — uses Proposition field";
    case "ignored":
      return "ignored — analysis only";
  }
}

function agentsLabel(p: SwarmPreset): string {
  if (p.min === p.max) return `${p.min} (fixed)`;
  return `${p.min}–${p.max} (rec ${p.recommended})`;
}

function directiveAccent(directive: DirectiveBehavior): string | undefined {
  if (directive === "honored") return "text-emerald-300";
  if (directive === "uses-proposition") return "text-sky-300";
  return "text-ink-400";
}

/** Label/value rows for preset hover tooltips. */
export function buildPresetTipFields(p: SwarmPreset): TipKvField[] {
  const fields: TipKvField[] = [
    { label: "id", value: p.id, mono: true },
    {
      label: "status",
      value: p.status === "active" ? "active" : "coming soon",
      accent: p.status === "active" ? "text-emerald-300" : "text-amber-300",
    },
    { label: "agents", value: agentsLabel(p), mono: true },
    { label: "model", value: p.recommendedModel, mono: true },
    {
      label: "directive",
      value: directiveShort(p.directive),
      accent: directiveAccent(p.directive),
    },
  ];
  if (p.useCases && p.useCases.length > 0) {
    fields.push({ label: "use cases", value: p.useCases.join(", ") });
  }
  fields.push({ label: "about", value: p.summary, multiline: true });
  return fields;
}

export function PresetTipContent({
  preset,
  footer,
}: {
  preset: SwarmPreset;
  footer?: ReactNode;
}) {
  const fields = buildPresetTipFields(preset);
  return (
    <FormattedTipContent title={preset.label} footer={footer}>
      {fields.map((field) => (
        <TipKvRow key={field.label} field={field} />
      ))}
    </FormattedTipContent>
  );
}

/** ⓘ target beside a field label — shows full metadata for the selected preset. */
export function PresetTooltip({ preset }: { preset: SwarmPreset }) {
  return (
    <InfoTip maxWidth={420}>
      <PresetTipContent preset={preset} />
    </InfoTip>
  );
}