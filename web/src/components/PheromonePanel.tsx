import { useMemo, useState } from "react";
import { useSwarm } from "../state/store";
import type { PheromoneEntry } from "../types";

// Phase 2a (2026-04-24): stigmergy-specific panel showing the shared
// annotation table that drives every agent's next-file pick. This is
// THE thing that makes stigmergy work — previously completely
// invisible from the UI.
//
// Reading this view:
//   - visits: how many agents have touched this file so far
//   - interest: mean (0-10) of "how interesting to dig deeper"
//   - confidence: mean (0-10) of "how well I understand this now"
//   - latestNote: the most recent annotation text
//
// Stigmergy's picking rule (rough): untouched files attract, high-
// interest-low-confidence files attract, well-covered files repel.
// So sorting by "pick score" approximates what the NEXT agent will
// pick. We expose the default sort (attract-first) and let the user
// flip by column.
type SortKey = "file" | "visits" | "interest" | "confidence" | "score";

export function PheromonePanel() {
  const pheromones = useSwarm((s) => s.pheromones);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortAsc, setSortAsc] = useState(false);

  const rows = useMemo(() => {
    const entries = Object.entries(pheromones);
    const arr = entries.map(([file, state]) => ({
      file,
      ...state,
      score: computeScore(state),
    }));
    arr.sort((a, b) => {
      const av = rowValue(a, sortKey);
      const bv = rowValue(b, sortKey);
      if (typeof av === "string" && typeof bv === "string") {
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return arr;
  }, [pheromones, sortKey, sortAsc]);

  if (rows.length === 0) {
    return (
      <div className="h-full overflow-auto p-6 text-sm text-ink-400">
        No pheromone annotations yet. The table populates as agents annotate files each round —
        the first round usually produces the first entries once all agents complete their turns.
      </div>
    );
  }

  const onHeader = (key: SortKey) => {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key === "file" ? true : false);
    }
  };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="text-xs text-ink-500 mb-2">
        Pheromone table · {rows.length} file{rows.length === 1 ? "" : "s"} annotated · sorted by{" "}
        <span className="text-ink-300">{sortKey}</span>{" "}
        <span className="text-ink-600">({sortAsc ? "↑" : "↓"})</span>
      </div>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-left text-ink-500 uppercase tracking-wide text-[10px] border-b border-ink-700">
            <SortTh label="File" active={sortKey === "file"} asc={sortAsc} onClick={() => onHeader("file")} />
            <SortTh label="Visits" active={sortKey === "visits"} asc={sortAsc} onClick={() => onHeader("visits")} right />
            <SortTh label="Interest" active={sortKey === "interest"} asc={sortAsc} onClick={() => onHeader("interest")} right />
            <SortTh label="Confidence" active={sortKey === "confidence"} asc={sortAsc} onClick={() => onHeader("confidence")} right />
            <SortTh label="Pick score" active={sortKey === "score"} asc={sortAsc} onClick={() => onHeader("score")} right />
            <th className="py-1 px-2">Latest note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.file} className="border-b border-ink-800/60 hover:bg-ink-800/40">
              <td className="py-1 px-2 text-ink-200 truncate max-w-xs">{r.file}</td>
              <td className="py-1 px-2 text-right text-ink-300">{r.visits}</td>
              <td className="py-1 px-2 text-right">
                <Bar value={r.avgInterest} max={10} color="emerald" />
              </td>
              <td className="py-1 px-2 text-right">
                <Bar value={r.avgConfidence} max={10} color="sky" />
              </td>
              <td className="py-1 px-2 text-right text-ink-300">{r.score.toFixed(1)}</td>
              <td className="py-1 px-2 text-ink-400 italic truncate max-w-md">{r.latestNote}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-6 text-xs text-ink-500">
        <p className="mb-1">
          <span className="text-ink-300">Pick score</span> approximates which file the NEXT agent is likely
          to choose. Higher = more attractive. High interest + low confidence = big score
          (the model wants to dig deeper but isn't sure yet); low interest + high confidence = low score
          (this is well-understood already, don't waste more turns).
        </p>
        <p>
          Stigmergy's full picking rule also weights visits inversely (repel well-covered files) and
          injects jitter so agents don't all converge on the same top-score file.
        </p>
      </div>
    </div>
  );
}

function rowValue(
  r: PheromoneEntry & { file: string; score: number },
  key: SortKey,
): string | number {
  switch (key) {
    case "file":
      return r.file;
    case "visits":
      return r.visits;
    case "interest":
      return r.avgInterest;
    case "confidence":
      return r.avgConfidence;
    case "score":
      return r.score;
  }
}

// Approximate pick score: interest weighted by (1 - confidence/max) so
// high-interest-low-confidence wins, then divided by (visits+1) so
// well-covered files are dampened. Not authoritative — the server's
// full picking rule is richer — but gives the user a clear "which
// file is the next agent leaning toward" signal.
function computeScore(state: PheromoneEntry): number {
  const interestWeight = state.avgInterest; // 0-10
  const confidenceDampen = Math.max(0, 10 - state.avgConfidence); // 0-10
  const visitsDampen = 1 / (state.visits + 1);
  return interestWeight * confidenceDampen * visitsDampen;
}

function SortTh({
  label,
  active,
  asc,
  onClick,
  right,
}: {
  label: string;
  active: boolean;
  asc: boolean;
  onClick: () => void;
  right?: boolean;
}) {
  return (
    <th className={`py-1 px-2 ${right ? "text-right" : ""}`}>
      <button
        onClick={onClick}
        className={`hover:text-ink-200 ${active ? "text-ink-200" : "text-ink-500"}`}
      >
        {label}
        {active ? <span className="ml-1 text-ink-500">{asc ? "↑" : "↓"}</span> : null}
      </button>
    </th>
  );
}

function Bar({
  value,
  max,
  color,
}: {
  value: number;
  max: number;
  color: "emerald" | "sky";
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const colorClass = color === "emerald" ? "bg-emerald-500/50" : "bg-sky-500/50";
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-ink-300 tabular-nums">{value.toFixed(1)}</span>
      <div className="w-16 h-1.5 bg-ink-800 rounded-full overflow-hidden shrink-0">
        <div className={`h-full ${colorClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
