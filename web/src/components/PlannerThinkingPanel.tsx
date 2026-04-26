// Task #160: dedicated "Planner is thinking…" widget for the Board tab.
//
// During the planning phase the planner agent emits streaming text via the
// existing partialStreams + agent_streaming WS infrastructure (Task #39).
// That text already lands in the Transcript tab, but it blends with other
// agent activity and the user has to be on Transcript to see it. This
// widget mounts on the Board tab when the planner is mid-turn and surfaces:
//   - char count + word count of the streaming text so far
//   - estimated criteria-so-far (Task #162: cheap regex counter)
//   - scrolling tail of the last ~600 chars of text
//
// Disappears once the planner's turn finalizes (status flips to ready or
// the streaming buffer clears).

import { useEffect, useState } from "react";
import { useSwarm } from "../state/store";

// Task #162: cheap criterion counter. The planner's contract is a JSON
// envelope `{"missionStatement": "...", "criteria": [{...}, {...}, ...]}`.
// We can't parse the partial stream as full JSON (often unbalanced
// mid-write), but counting closing braces inside the criteria array gives
// a useful approximation of how many criteria are complete.
//
// Heuristic: find the start of the `"criteria"` array, then count `}` on
// the suffix. Off-by-one tolerated — it's a progress indicator, not an
// audit. Returns 0 when criteria array hasn't been opened yet.
function countCriteriaInProgress(text: string): number {
  const idx = text.indexOf('"criteria"');
  if (idx < 0) return 0;
  // Slice from the criteria array start; skip ahead past the array's '['
  // to avoid counting the array-level brace.
  const afterCriteria = text.slice(idx);
  const arrStart = afterCriteria.indexOf("[");
  if (arrStart < 0) return 0;
  const inArray = afterCriteria.slice(arrStart + 1);
  // Each criterion looks like {"id": "...", ...}. Count } that aren't
  // inside a string (rough — assume strings can't contain unescaped }).
  let count = 0;
  let inString = false;
  let escape = false;
  for (const ch of inArray) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === "\"") { inString = !inString; continue; }
    if (!inString && ch === "}") count++;
  }
  return count;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function PlannerThinkingPanel() {
  const phase = useSwarm((s) => s.phase);
  const agents = useSwarm((s) => s.agents);
  const streaming = useSwarm((s) => s.streaming);
  // Tick every second so char/word counts on the snapshot feel live even
  // when no new chunks arrive (text length doesn't change, but the
  // "started Xs ago" number does).
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Identify the planner — for blackboard, agent index 1. We mount only
  // for blackboard runs (the parent SwarmView already gates Board tab on
  // showBlackboardTabs). Filter by status: only show when the planner is
  // genuinely thinking (not ready / failed). When a streaming buffer is
  // present for the planner, prefer that even over status flip races.
  const plannerAgent = Object.values(agents).find((a) => a.index === 1);
  const plannerId = plannerAgent?.id;
  const plannerText = plannerId ? (streaming[plannerId] ?? "") : "";
  const isThinking = plannerAgent?.status === "thinking" || plannerAgent?.status === "retrying";
  const hasStream = plannerText.length > 0;

  // Show during planning OR when planner has an active stream. Hide once
  // both conditions clear.
  if (!plannerAgent) return null;
  if (phase !== "planning" && !hasStream && !isThinking) return null;

  const chars = plannerText.length;
  const words = countWords(plannerText);
  const criteria = countCriteriaInProgress(plannerText);
  const startedAt = plannerAgent.thinkingSince;
  const elapsedS = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  const tail = plannerText.length > 600 ? plannerText.slice(-600) : plannerText;

  return (
    <div className="rounded border-2 border-emerald-700/60 bg-emerald-950/20 p-3 text-xs space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-emerald-200 font-semibold uppercase tracking-wider">
          ✦ Planner is thinking
        </div>
        <div className="text-emerald-400/80 font-mono text-[11px]">
          agent-{plannerAgent.index} · {elapsedS}s elapsed
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Chars" value={chars.toLocaleString()} />
        <Stat label="Words" value={words.toLocaleString()} />
        <Stat label="Criteria so far" value={criteria.toString()} />
      </div>
      {tail.length > 0 ? (
        <div className="rounded bg-ink-900/80 border border-ink-700 p-2 font-mono text-[11px] text-ink-200 max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
          {tail.length < plannerText.length ? <span className="text-ink-600">…</span> : null}
          {tail}
          <span className="inline-block w-1.5 h-3 bg-emerald-400 ml-0.5 animate-pulse align-middle" aria-label="cursor" />
        </div>
      ) : (
        <div className="text-ink-500 italic">
          {isThinking
            ? "Planner started but no streaming text yet (cold start or tool calls in flight)…"
            : "Planning phase active but planner is idle."}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-emerald-900/30 border border-emerald-800/50 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-emerald-300/70">{label}</div>
      <div className="text-emerald-100 font-mono text-sm">{value}</div>
    </div>
  );
}

// Exported for tests + #161 to swap in a smarter parser later.
export const _internals = { countCriteriaInProgress, countWords };
