import type { TranscriptEntry } from "../../types";
import { formatServerSummary } from "../../../../shared/src/formatServerSummary";

/** Low-salience pipeline chatter — one-line status, not expandable bubbles. */
export function isCompactPipelineStatus(entry: TranscriptEntry): boolean {
  if (entry.summary?.kind === "web_tool") return true;
  const t = entry.text || "";
  return /^Research pre-pass:/i.test(t) || /Literature research:/i.test(t);
}

export function compactPipelineStatusText(entry: TranscriptEntry): string {
  if (entry.summary?.kind === "web_tool") {
    return formatServerSummary(entry.summary);
  }
  return entry.text;
}

export function compactPipelineStatusChip(entry: TranscriptEntry): string {
  if (entry.summary?.kind === "web_tool") return entry.summary.tool;
  if (/^Research pre-pass:/i.test(entry.text)) return "research";
  if (/Literature research:/i.test(entry.text)) return "research";
  return "status";
}