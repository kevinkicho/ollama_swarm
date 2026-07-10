import { ANOMALY_FLAG_LABELS } from "../../lib/eventLogUi";

export function AnomalyBadges({ flags, compact = false }: { flags: string[]; compact?: boolean }) {
  if (flags.length === 0) return null;
  return (
    <>
      {flags.map((f) => {
        const meta = ANOMALY_FLAG_LABELS[f] ?? {
          label: f,
          color: "text-ink-300 bg-ink-800 border-ink-600",
        };
        return (
          <span
            key={f}
            className={`${compact ? "text-[8px] px-0.5" : "text-[9px] px-1"} py-0 rounded border ${meta.color}`}
          >
            {meta.label}
          </span>
        );
      })}
    </>
  );
}
