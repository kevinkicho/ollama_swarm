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

  // Git-native: { workingTree: true, files, message } (preferred over hunks).
  if (
    obj.workingTree === true
    || obj.mode === "workingTree"
    || obj.mode === "git"
    || obj.git === true
  ) {
    const filesRaw = obj.files ?? obj.filesTouched;
    const files = Array.isArray(filesRaw)
      ? filesRaw.map(String).filter(Boolean).slice(0, 24)
      : [];
    const message = String(obj.message ?? obj.summary ?? "working-tree changes").slice(0, 200);
    return {
      kind: "worker_working_tree",
      fileCount: files.length,
      files,
      message,
    };
  }

  // Worker hunks: { hunks: [...] } — count by op, identify primary file.
  // Includes replace_between / write / delete (2010479c) so server tags
  // still attach when only those ops are present.
  if (Array.isArray(obj.hunks)) {
    const ops = { replace: 0, create: 0, append: 0 };
    const filesSeen = new Set<string>();
    let firstFile: string | undefined;
    let totalChars = 0;
    let otherOps = 0;
    for (const h of obj.hunks) {
      if (typeof h !== "object" || h === null) continue;
      const hunk = h as Record<string, unknown>;
      const op = typeof hunk.op === "string" ? hunk.op : undefined;
      if (op === "replace" || op === "replace_between") {
        ops.replace++;
        if (typeof hunk.search === "string") totalChars += hunk.search.length;
        if (typeof hunk.start === "string") totalChars += hunk.start.length;
        if (typeof hunk.replace === "string") totalChars += hunk.replace.length;
      } else if (op === "create" || op === "write") {
        ops.create++;
        if (typeof hunk.content === "string") totalChars += hunk.content.length;
      } else if (op === "append") {
        ops.append++;
        if (typeof hunk.content === "string") totalChars += hunk.content.length;
      } else if (op === "delete") {
        otherOps++;
      } else {
        // Unknown op — exclude from count (UI still gets tag from known siblings).
        continue;
      }
      const file = typeof hunk.file === "string" ? hunk.file : undefined;
      if (file !== undefined) {
        filesSeen.add(file);
        if (firstFile === undefined) firstFile = file;
      }
    }
    const hunkCount = ops.replace + ops.create + ops.append + otherOps;
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

  // Build / tool command result: { ok, exitCode, summary }
  if (
    typeof obj.ok === "boolean"
    && (typeof obj.exitCode === "number" || typeof obj.summary === "string")
  ) {
    return {
      kind: "build_result",
      ok: obj.ok,
      exitCode: typeof obj.exitCode === "number" ? obj.exitCode : undefined,
      summary:
        typeof obj.summary === "string"
          ? obj.summary.slice(0, 400)
          : obj.ok
            ? "ok"
            : "failed",
    };
  }

  // First-pass contract envelope (council emit without dedicated tagger)
  if (typeof obj.missionStatement === "string" && Array.isArray(obj.criteria)) {
    return {
      kind: "contract",
      criteriaCount: obj.criteria.length,
      missionPreview: obj.missionStatement.slice(0, 120),
    };
  }

  // Planner todo array (top-level) — rare on council but helpful for BB
  if (Array.isArray(parsed) && parsed.length > 0) {
    const first = parsed[0];
    if (
      first
      && typeof first === "object"
      && typeof (first as { description?: unknown }).description === "string"
      && Array.isArray((first as { expectedFiles?: unknown }).expectedFiles)
    ) {
      return { kind: "planner_todos", todoCount: parsed.length };
    }
  }

  return undefined;
}

// 2026-05-04 (R11 wiring): the local lenient parser was replaced by
// repairAndParseJson, which subsumes its three strategies (strict,
// fence-strip, inner-object) plus soft repairs (trailing comma, smart
// quotes, missing braces). The tryParseJson helper has been deleted;
// see swarm/repairJson.ts for the consolidated implementation.
