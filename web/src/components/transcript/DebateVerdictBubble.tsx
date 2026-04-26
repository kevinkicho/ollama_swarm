import type { TranscriptEntrySummary } from "../../types";

// Task #81 (2026-04-25): scorecard renderer for the JUDGE's structured
// verdict. Two-column grid (PRO / CON) with strongest + weakest per
// side, then a footer strip with the decisive call + next action.
export function DebateVerdictBubble({
  verdict: v,
  header,
  ts,
}: {
  verdict: Extract<TranscriptEntrySummary, { kind: "debate_verdict" }>;
  header: React.ReactNode;
  ts: number;
}) {
  const tsStr = new Date(ts).toLocaleTimeString();
  const winnerColor =
    v.winner === "pro" ? "text-emerald-300 border-emerald-700/60 bg-emerald-950/20"
    : v.winner === "con" ? "text-rose-300 border-rose-700/60 bg-rose-950/20"
    : "text-amber-300 border-amber-700/60 bg-amber-950/20";
  const winnerLabel = v.winner === "pro" ? "PRO WINS" : v.winner === "con" ? "CON WINS" : "TIE";
  return (
    <div className={`rounded-md p-3 border-2 text-sm ${winnerColor}`}>
      {header}
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <div className="text-xs uppercase tracking-wider font-bold">
          ⚖ {winnerLabel} · confidence: {v.confidence.toUpperCase()}
        </div>
        <div className="text-[10px] text-ink-500 font-mono">round {v.round} · {tsStr}</div>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded border border-emerald-700/40 bg-emerald-950/30 p-2">
          <div className="text-[10px] uppercase tracking-wider text-emerald-300 font-semibold mb-1">PRO</div>
          {v.proStrongest ? (
            <div className="text-[11px] text-ink-200 mb-1">
              <span className="text-emerald-400">strongest:</span> {v.proStrongest}
            </div>
          ) : null}
          {v.proWeakest ? (
            <div className="text-[11px] text-ink-300">
              <span className="text-rose-400">weakest:</span> {v.proWeakest}
            </div>
          ) : null}
        </div>
        <div className="rounded border border-rose-700/40 bg-rose-950/30 p-2">
          <div className="text-[10px] uppercase tracking-wider text-rose-300 font-semibold mb-1">CON</div>
          {v.conStrongest ? (
            <div className="text-[11px] text-ink-200 mb-1">
              <span className="text-rose-400">strongest:</span> {v.conStrongest}
            </div>
          ) : null}
          {v.conWeakest ? (
            <div className="text-[11px] text-ink-300">
              <span className="text-emerald-400">weakest:</span> {v.conWeakest}
            </div>
          ) : null}
        </div>
      </div>
      {v.decisive ? (
        <div className="rounded border border-ink-700 bg-ink-950/40 p-2 mb-2">
          <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold mb-1">Decisive</div>
          <div className="text-[11px] text-ink-200">{v.decisive}</div>
        </div>
      ) : null}
      {v.nextAction ? (
        <div className="rounded border border-amber-700/40 bg-amber-950/20 p-2">
          <div className="text-[10px] uppercase tracking-wider text-amber-300 font-semibold mb-1">Next action</div>
          <div className="text-[11px] text-ink-200">{v.nextAction}</div>
        </div>
      ) : null}
    </div>
  );
}
