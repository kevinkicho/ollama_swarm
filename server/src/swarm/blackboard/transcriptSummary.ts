// Unit 54: lenient summarizer for raw agent responses. Extracts the
// minimum structure needed for the UI's collapsed transcript line
// without enforcing the strict validation that parseWorkerResponse
// applies (which rejects hunks whose file isn't in expectedFiles —
// useful at commit time, irrelevant for "tell the user what the model
// said in one line").
//
// Returns undefined when the text doesn't look like a known JSON
// envelope; the UI then falls back to its existing truncated-with-
// "Show more" rendering. Best-effort: any parse failure yields
// undefined, never throws.

import type { TranscriptEntrySummary } from "../../types.js";
import { repairAndParseJson } from "../repairJson.js";

export function summarizeAgentResponse(raw: string): TranscriptEntrySummary | undefined {
  const attempt = repairAndParseJson(raw);
  const parsed = attempt?.value;
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;

  // Worker skip: { hunks: [], skip: "reason" } OR { skip: "reason" }
  // (no hunks). Worker prompt rule 6 is the canonical shape but lenient
  // here — accept either.
  if (typeof obj.skip === "string" && obj.skip.trim().length > 0) {
    return { kind: "worker_skip", reason: obj.skip.trim() };
  }

  // Worker hunks: { hunks: [...] } — count by op, identify primary file.
  if (Array.isArray(obj.hunks)) {
    const ops = { replace: 0, create: 0, append: 0 };
    const filesSeen = new Set<string>();
    let firstFile: string | undefined;
    let totalChars = 0;
    for (const h of obj.hunks) {
      if (typeof h !== "object" || h === null) continue;
      const hunk = h as Record<string, unknown>;
      const op = typeof hunk.op === "string" ? hunk.op : undefined;
      if (op === "replace") {
        ops.replace++;
        if (typeof hunk.search === "string") totalChars += hunk.search.length;
        if (typeof hunk.replace === "string") totalChars += hunk.replace.length;
      } else if (op === "create") {
        ops.create++;
        if (typeof hunk.content === "string") totalChars += hunk.content.length;
      } else if (op === "append") {
        ops.append++;
        if (typeof hunk.content === "string") totalChars += hunk.content.length;
      } else {
        // Unknown op — count it as 0 so the UI can still show
        // "N hunks (some unknown)" without misleading op breakdown.
        continue;
      }
      const file = typeof hunk.file === "string" ? hunk.file : undefined;
      if (file !== undefined) {
        filesSeen.add(file);
        if (firstFile === undefined) firstFile = file;
      }
    }
    const hunkCount = ops.replace + ops.create + ops.append;
    if (hunkCount === 0) {
      // Empty `hunks: []` with no skip reason — treat as a no-op
      // skip rather than a meaningful response.
      return { kind: "worker_skip", reason: "empty hunks (no work)" };
    }
    return {
      kind: "worker_hunks",
      hunkCount,
      ops,
      firstFile,
      multipleFiles: filesSeen.size > 1,
      totalChars,
    };
  }

  return undefined;
}

// 2026-05-04 (R11 wiring): the local lenient parser was replaced by
// repairAndParseJson, which subsumes its three strategies (strict,
// fence-strip, inner-object) plus soft repairs (trailing comma, smart
// quotes, missing braces). The tryParseJson helper has been deleted;
// see swarm/repairJson.ts for the consolidated implementation.
