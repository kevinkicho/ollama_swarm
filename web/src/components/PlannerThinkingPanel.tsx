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
  // Each criterion looks like {"id": "...", ...}. Count `}` that close a
  // top-level object inside the criteria array (depth==1 → 0 transition).
  // We track bracket depth so we don't count nested object closes (depth
  // 2+→1 isn't a criterion completion). Stop when we exit the array
  // (the matching `]`) to avoid counting the wrapper object's closing
  // `}` that appears after the array.
  let count = 0;
  let depth = 0; // depth of {} inside the criteria array
  let inString = false;
  let escape = false;
  for (const ch of inArray) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) count++;
    } else if (ch === "]" && depth === 0) {
      // Hit the criteria-array closer — stop. Anything after this is
      // wrapper-object territory, not part of the criteria count.
      break;
    }
  }
  return count;
}

// Task #161: smarter partial-JSON extraction. Instead of a real streaming
// parser (heavy + fragile), extract specific structured fields from the
// partial stream via tolerant regex/scanner. Returns whatever's complete
// enough to render. Safe to call on arbitrary mid-write text — no throw
// path, missing fields just return null/undefined.
//
// Three things we surface:
//   - missionStatement: full string if its closing quote is present
//   - inProgressDescription: partial text of the LAST criterion's
//     description (the one currently being written)
//   - position: 1-indexed criterion number being worked on (counted +1)
export interface PlannerStreamExtract {
  missionStatement: string | null;
  inProgressDescription: string | null;
  /** 1-indexed position of the criterion currently being written (or
   *  the count of completed criteria + 1 while in-flight). */
  inProgressPosition: number | null;
}

// Match `"missionStatement"\s*:\s*"..."` capturing the string body up to
// the unescaped closing quote. Returns null if the closing quote hasn't
// arrived yet (still streaming).
function extractMissionStatement(text: string): string | null {
  const keyIdx = text.indexOf('"missionStatement"');
  if (keyIdx < 0) return null;
  // Skip past key + colon + opening quote.
  const afterKey = text.slice(keyIdx + '"missionStatement"'.length);
  const colonIdx = afterKey.indexOf(":");
  if (colonIdx < 0) return null;
  const afterColon = afterKey.slice(colonIdx + 1);
  // Find the opening quote of the value.
  const openQuoteIdx = afterColon.indexOf('"');
  if (openQuoteIdx < 0) return null;
  const valueStart = afterColon.slice(openQuoteIdx + 1);
  // Walk forward until we find an unescaped closing quote.
  let escape = false;
  for (let i = 0; i < valueStart.length; i++) {
    const ch = valueStart[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') {
      return valueStart.slice(0, i);
    }
  }
  // String not closed yet — treat as null (we'll show it as "writing
  // mission statement…" in the UI). Could optionally return the
  // partial; chose null for simplicity.
  return null;
}

// Find the in-progress criterion's description — useful for showing
// "currently writing: '<partial description>...'". Looks at the LAST
// `{` after the criteria array opens AND counts closing `}` to confirm
// we're INSIDE an unclosed object. Then within that fragment, extracts
// the partial description (whether closed or not).
function extractInProgressCriterion(text: string): {
  position: number | null;
  partialDescription: string | null;
} {
  const criteriaIdx = text.indexOf('"criteria"');
  if (criteriaIdx < 0) return { position: null, partialDescription: null };
  const afterCriteria = text.slice(criteriaIdx);
  const arrStart = afterCriteria.indexOf("[");
  if (arrStart < 0) return { position: null, partialDescription: null };
  const inArray = afterCriteria.slice(arrStart + 1);

  // Walk through inArray, tracking depth/strings to find the index of
  // the LAST { that hasn't been matched by a closing }.
  let depth = 0;
  let lastUnclosedOpenAt = -1;
  let inString = false;
  let escape = false;
  let completedCount = 0;
  for (let i = 0; i < inArray.length; i++) {
    const ch = inArray[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) lastUnclosedOpenAt = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        completedCount++;
        lastUnclosedOpenAt = -1;
      }
    }
  }

  if (lastUnclosedOpenAt < 0) {
    // No in-flight criterion — either nothing started yet, or we just
    // finished one and are between criteria.
    return { position: null, partialDescription: null };
  }
  // We have an unclosed criterion. Position = completedCount + 1.
  const position = completedCount + 1;
  const fragment = inArray.slice(lastUnclosedOpenAt);
  // Try to extract the partial "description" from this fragment.
  const descKeyIdx = fragment.indexOf('"description"');
  if (descKeyIdx < 0) return { position, partialDescription: null };
  const afterDescKey = fragment.slice(descKeyIdx + '"description"'.length);
  const colonIdx = afterDescKey.indexOf(":");
  if (colonIdx < 0) return { position, partialDescription: null };
  const afterColon = afterDescKey.slice(colonIdx + 1);
  const openQuoteIdx = afterColon.indexOf('"');
  if (openQuoteIdx < 0) return { position, partialDescription: null };
  const descBody = afterColon.slice(openQuoteIdx + 1);
  // Walk for closing quote; if not found, return what we have so far.
  let escDesc = false;
  for (let i = 0; i < descBody.length; i++) {
    const ch = descBody[i];
    if (escDesc) { escDesc = false; continue; }
    if (ch === "\\") { escDesc = true; continue; }
    if (ch === '"') return { position, partialDescription: descBody.slice(0, i) };
  }
  // Closing quote not arrived — return the partial as-is.
  return { position, partialDescription: descBody };
}

export function extractPlannerStream(text: string): PlannerStreamExtract {
  const inProg = extractInProgressCriterion(text);
  return {
    missionStatement: extractMissionStatement(text),
    inProgressDescription: inProg.partialDescription,
    inProgressPosition: inProg.position,
  };
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
  const extract = extractPlannerStream(plannerText);
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
      {/* Task #161: structured extract surfacing — mission + in-flight criterion */}
      {extract.missionStatement ? (
        <div className="rounded bg-emerald-900/30 border border-emerald-800/50 px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-wider text-emerald-300/70">Mission statement</div>
          <div className="text-emerald-100 text-[12px] leading-snug">{extract.missionStatement}</div>
        </div>
      ) : null}
      {extract.inProgressPosition !== null ? (
        <div className="rounded bg-emerald-900/20 border border-emerald-800/30 px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-wider text-emerald-300/70">
            Currently writing criterion #{extract.inProgressPosition}
          </div>
          <div className="text-emerald-200/90 text-[12px] leading-snug font-mono">
            {extract.inProgressDescription
              ? <>{extract.inProgressDescription}<span className="text-emerald-400 animate-pulse">▌</span></>
              : <span className="italic text-emerald-300/60">building criterion structure…</span>}
          </div>
        </div>
      ) : null}
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

// Exported for tests.
export const _internals = { countCriteriaInProgress, countWords };
