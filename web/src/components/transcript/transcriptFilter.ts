// Client-side transcript filter for Transcript panel — extracted from Transcript.tsx.

import type { TranscriptEntry } from "../../types";

export type TranscriptFilterId =
  | "all"
  | "key"
  | "system"
  | "agents"
  | "audit"
  | "issues";

/**
 * Filter display entries by the Transcript bar selection.
 * "all" is the normal full view; other modes cut noise.
 */
export function filterTranscriptEntries(
  entries: readonly TranscriptEntry[],
  filter: TranscriptFilterId,
): TranscriptEntry[] {
  return entries.filter((e) => {
    if (filter === "all") return true;
    if (filter === "system") return e.role === "system";
    if (filter === "agents") {
      // Hide "Worker skip" noise from the Agents view.
      if (e.summary?.kind === "worker_skip") return false;
      return e.role === "agent" || e.role === "agent-stream";
    }
    if (filter === "audit") {
      const text = e.text || "";
      return text.includes("audit") || text.includes("Audit") || text.includes("Gate");
    }
    if (filter === "issues") {
      const text = e.text || "";
      return (
        text.includes("CONTRADICTION") ||
        text.includes("PARTIAL") ||
        text.includes("error") ||
        text.includes("failed")
      );
    }
    if (filter === "key") {
      const k = e.summary?.kind;
      if (k === "worker_skip") return false;
      const text = (e.text || "").toLowerCase();
      const isKey =
        [
          "council_synthesis",
          "mapreduce_synthesis",
          "role_diff_synthesis",
          "stigmergy_report",
          "debate_verdict",
          "run_finished",
          "deliverable",
          "stretch_goals",
          "worker_hunks",
          "contract",
          "goals",
          "seed_announce",
          "agents_ready",
          "run_start",
        ].includes(k || "") ||
        text.includes("synthesis") ||
        text.includes("verdict") ||
        text.includes("web_search") ||
        text.includes("web_fetch") ||
        text.includes("findings") ||
        text.includes("deliverable") ||
        k === "verifier_verdict";
      if (isKey) return true;
      if (e.role === "system") {
        return (
          text.includes("resuming") ||
          text.includes("ready") ||
          text.includes("seed") ||
          text.includes("goal-generation") ||
          text.includes("contract") ||
          text.includes("planner") ||
          text.includes("memory") ||
          text.includes("design memory") ||
          text.includes("directive") ||
          text.includes("halted") ||
          text.includes("failed") ||
          text.includes("finished") ||
          text.includes("pipeline") ||
          text.includes("council") ||
          text.includes("blackboard") ||
          text.includes("agents ready")
        );
      }
      if (e.role === "agent-stream" && (e.text || "").length > 80) return true;
      return false;
    }
    return true;
  });
}
