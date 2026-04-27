// V2 Step 4: extracted from Transcript.tsx so MessageBubble (the new
// per-entry renderer) can import it without dragging in the scroll
// container's deps. Pure function, no React — easier to unit test.
//
// Renders the discriminated server-side summary as a single human line.
// Mirrors the prose used by summarizeAgentJson for equivalent worker
// shapes so users don't see two different formats depending on which
// path computed the summary.

import type { TranscriptEntrySummary } from "../../types";

export function formatServerSummary(s: TranscriptEntrySummary): string {
  if (s.kind === "worker_skip") {
    return `Declined: ${s.reason}`;
  }
  // Task #43: orchestrator-worker assignments → one-line summary plus a
  // bullet block. Kept as a single string for the AgentJsonBubble path;
  // line breaks render via whitespace-pre-wrap.
  if (s.kind === "ow_assignments") {
    const lead =
      s.subtaskCount === 1
        ? `Orchestrator assigned 1 subtask:`
        : `Orchestrator assigned ${s.subtaskCount} subtasks:`;
    const lines = s.assignments.map(
      (a) => `  → agent-${a.agentIndex}: ${a.subtask}`,
    );
    return [lead, ...lines].join("\n");
  }
  // Phase 2b/2c: structural markers (council_draft, debate_turn) carry
  // metadata for preset-specific panels but don't have a useful one-line
  // form — fall back to a short descriptor so Bubble's summary display
  // isn't empty.
  if (s.kind === "council_draft") {
    return `Council · round ${s.round} · ${s.phase}`;
  }
  if (s.kind === "debate_turn") {
    return `Debate · round ${s.round} · ${s.role.toUpperCase()}`;
  }
  // Task #72: structural kinds rendered by dedicated grid components —
  // formatServerSummary is unused for these but the discriminated union
  // demands exhaustiveness. Return a one-line descriptor for safety
  // (e.g. if future code paths render them as plain text).
  if (s.kind === "run_finished") {
    return `Run finished — ${s.stopReason}`;
  }
  if (s.kind === "seed_announce") {
    return `Project seed — ${s.topLevel.length} top-level entries`;
  }
  if (s.kind === "council_synthesis") {
    return `Council synthesis (${s.rounds} round${s.rounds === 1 ? "" : "s"})`;
  }
  if (s.kind === "stigmergy_report") {
    return `Stigmergy report-out (${s.filesRanked} files ranked)`;
  }
  if (s.kind === "stretch_goals") {
    return `Stretch goals (${s.goals.length} ranked, tier ${s.tier})`;
  }
  if (s.kind === "verifier_verdict") {
    return `Verifier ${s.verdict} on ${s.proposingAgentId}`;
  }
  if (s.kind === "debate_verdict") {
    return `Debate verdict — ${s.winner.toUpperCase()} (${s.confidence})`;
  }
  if (s.kind === "mapreduce_synthesis") {
    return `Map-reduce synthesis (cycle ${s.cycle})`;
  }
  if (s.kind === "role_diff_synthesis") {
    return `Role-diff synthesis (${s.rounds} round${s.rounds === 1 ? "" : "s"}, ${s.roles} roles)`;
  }
  if (s.kind === "next_action_phase") {
    return `Build phase — ${s.role}`;
  }
  // Task #165: pause/resume on Ollama-quota wall
  if (s.kind === "quota_paused") {
    const sc = s.statusCode ? `${s.statusCode}` : "quota";
    return `Paused — Ollama wall (${sc}); probing every 5min until clear`;
  }
  if (s.kind === "quota_resumed") {
    const min = Math.round(s.pausedMs / 60_000);
    return `Resumed — wall cleared after ~${min} min`;
  }
  // worker_hunks (only kind remaining after all the if-returns above)
  const opParts: string[] = [];
  if (s.ops.replace > 0) opParts.push(`${s.ops.replace} replace`);
  if (s.ops.create > 0) opParts.push(`${s.ops.create} create`);
  if (s.ops.append > 0) opParts.push(`${s.ops.append} append`);
  const opSummary = opParts.length === 1 ? opParts[0] : opParts.join(", ");
  const hunkLabel = s.hunkCount === 1 ? "1 hunk" : `${s.hunkCount} hunks`;
  const where = s.multipleFiles
    ? `across multiple files`
    : s.firstFile
      ? `in ${s.firstFile}`
      : `(no file)`;
  const charsSuffix = s.totalChars > 0 ? ` (${s.totalChars.toLocaleString()} chars)` : "";
  return `Wrote ${hunkLabel} (${opSummary}) ${where}${charsSuffix}`;
}
