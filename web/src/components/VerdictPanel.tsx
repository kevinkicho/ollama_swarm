import { useMemo } from "react";
import { useSwarm } from "../state/store";
import type { TranscriptEntry } from "../types";

// Phase 2c (2026-04-24): debate-judge specific view.
// Lays out PRO/CON pairs side-by-side per round, then renders the
// JUDGE's final verdict in a distinct block at the bottom.
//
// Reads transcript entries tagged by DebateJudgeRunner with a
// summary.kind === "debate_turn" carrying { round, role }.
export function VerdictPanel() {
  const transcript = useSwarm((s) => s.transcript);

  const buckets = useMemo(() => {
    const byRound = new Map<number, { pro?: TranscriptEntry; con?: TranscriptEntry; judge?: TranscriptEntry }>();
    for (const e of transcript) {
      if (e.role !== "agent") continue;
      if (!e.summary || e.summary.kind !== "debate_turn") continue;
      const r = e.summary.round;
      if (!byRound.has(r)) byRound.set(r, {});
      const slot = byRound.get(r)!;
      slot[e.summary.role] = e;
    }
    return byRound;
  }, [transcript]);

  const rounds = Array.from(buckets.keys()).sort((a, b) => a - b);

  if (rounds.length === 0) {
    return (
      <div className="h-full overflow-auto p-6 text-sm text-ink-400">
        No debate turns yet. PRO and CON exchange arguments each round; JUDGE delivers the verdict
        on the final round only.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 text-sm">
      {rounds.map((r) => {
        const slot = buckets.get(r)!;
        const isFinalRound = r === Math.max(...rounds);
        return (
          <div key={r} className="mb-6">
            <div className="text-[10px] uppercase tracking-wider text-ink-500 mb-2">
              Round {r}
              {isFinalRound ? " · final" : ""}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <ArgumentCell
                label="PRO"
                colorClass="border-emerald-700 bg-emerald-950/30"
                labelColor="text-emerald-300"
                entry={slot.pro}
              />
              <ArgumentCell
                label="CON"
                colorClass="border-rose-700 bg-rose-950/30"
                labelColor="text-rose-300"
                entry={slot.con}
              />
            </div>
            {slot.judge ? (
              <div className="mt-3 border border-sky-700 bg-sky-950/30 rounded p-3">
                <div className="text-[10px] uppercase tracking-wider text-sky-300 mb-1">
                  JUDGE verdict · {new Date(slot.judge.ts).toLocaleTimeString()}
                </div>
                <div className="whitespace-pre-wrap text-ink-200 leading-snug">{slot.judge.text}</div>
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="mt-6 text-xs text-ink-500">
        <p>
          PRO argues FOR the proposition each round; CON argues AGAINST. JUDGE only fires on the
          final round and scores both sides. If you don't see a JUDGE block, the run hasn't reached
          its final round yet.
        </p>
      </div>
    </div>
  );
}

function ArgumentCell({
  label,
  colorClass,
  labelColor,
  entry,
}: {
  label: string;
  colorClass: string;
  labelColor: string;
  entry?: TranscriptEntry;
}) {
  return (
    <div className={`border rounded p-3 ${colorClass}`}>
      <div className={`text-[10px] uppercase tracking-wider mb-1 ${labelColor}`}>
        {label}
        {entry ? ` · ${new Date(entry.ts).toLocaleTimeString()}` : ""}
      </div>
      {entry ? (
        <div className="whitespace-pre-wrap text-ink-300 leading-snug text-xs">{entry.text}</div>
      ) : (
        <div className="italic text-ink-500 text-xs">— no entry yet —</div>
      )}
    </div>
  );
}
