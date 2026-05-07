import { useSwarm } from "../state/store";

export function OutcomeChip() {
  const outcome = useSwarm((s) => s.outcome);
  if (!outcome) return null;

  const color =
    outcome.score >= 7
      ? "bg-emerald-700 text-emerald-100"
      : outcome.score >= 4
        ? "bg-amber-700 text-amber-100"
        : "bg-red-700 text-red-100";

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono ${color}`}>
      <span>{outcome.score.toFixed(1)}</span>
      <span className="opacity-60">/10</span>
      <span className="ml-1 opacity-80 normal-case">{outcome.verdict.replace("-", " ")}</span>
    </span>
  );
}