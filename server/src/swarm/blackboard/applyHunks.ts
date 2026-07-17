// Pure patch-apply logic for v2 worker output.
//
// Background: workers used to emit full-file replacements ({file, newText}).
// That made prompts explode on large files — a worker editing a 49KB README
// sent the whole 49KB back, on top of receiving it in the prompt. Combined
// with Ollama cloud latency, that blew past undici's 5-min header timeout on
// every README-touching todo (see phase11c-medium-v5 run, c2 unmet).
//
// The replacement is Aider-style search/replace hunks:
//   {op: "replace", file: "...", search: "<exact text>", replace: "<new text>"}
// The search block must match exactly once in the current file. If it doesn't,
// we fail closed with a clear reason — the replanner can then retry with a
// more specific anchor, or the worker can try again.
//
// Ops: replace (exact anchor), create, append, delete, plus bulk-friendly
// write (full file) and replace_between (heading/section without needing the
// omitted middle of a windowed file in the prompt).
//
// This module is pure + side-effect free + unit-testable. The runner groups
// worker-emitted hunks by file, reads the current file content, calls
// applyFileHunks, and then CAS-writes the result.

import {
  buildApplyMissReport,
  countOccurrences,
  normalizeSearchWhitespace,
  type ApplyMissKind,
  type ApplyMissReport,
} from "./applyMissReport.js";

export type { ApplyMissKind, ApplyMissReport } from "./applyMissReport.js";

export type Hunk =
  | { op: "replace"; file: string; search: string; replace: string }
  | { op: "create"; file: string; content: string }
  | { op: "append"; file: string; content: string }
  | { op: "delete"; file: string }
  /** Full-file body. Works on existing or missing files (creates when missing). */
  | { op: "write"; file: string; content: string }
  /**
   * Replace from the first unique `start` marker through (not including)
   * `endExclusive` when set, or through EOF when omitted. Lets workers edit
   * large sections without pasting the omitted middle into `search`.
   */
  | {
      op: "replace_between";
      file: string;
      start: string;
      endExclusive?: string;
      replace: string;
    };

export type ApplyFileResult =
  | { ok: true; newText: string }
  | { ok: false; error: string; miss?: ApplyMissReport };

export type ApplyResult =
  | { ok: true; newTextsByFile: Record<string, string> }
  | { ok: false; error: string; miss?: ApplyMissReport };

function failWithMiss(
  input: {
    file: string;
    hunkIndex: number;
    op: string;
    kind: ApplyMissKind;
    needle: string;
    matchCount: number;
    fileText: string;
    message: string;
    focusOffset?: number | null;
  },
): ApplyFileResult {
  return {
    ok: false,
    error: input.message,
    miss: buildApplyMissReport(input),
  };
}

// Apply all hunks for a single file in sequence. Each hunk sees the output
// of the previous one — so a second "replace" can target text produced by
// the first. Callers that don't want this coupling should split into
// multiple applyFileHunks calls.
export function applyFileHunks(
  currentText: string | null,
  hunks: Hunk[],
): ApplyFileResult {
  if (hunks.length === 0) {
    // Caller shouldn't ask us to apply nothing, but if it does the answer
    // is "unchanged". null → empty string so the write path has something
    // to persist; real callers will skip the write in this case anyway.
    return { ok: true, newText: currentText ?? "" };
  }

  // Path A: file didn't exist yet. Valid: single create, or single write.
  if (currentText === null) {
    if (hunks.length !== 1) {
      const file = hunks[0]?.file ?? "";
      const message = `file does not exist — expected exactly one "create" or "write" hunk, got ${hunks.length}`;
      return failWithMiss({
        file,
        hunkIndex: 0,
        op: hunks[0]?.op ?? "unknown",
        kind: "other",
        needle: "",
        matchCount: 0,
        fileText: "",
        message,
      });
    }
    const only = hunks[0];
    if (only.op === "create" || only.op === "write") {
      return { ok: true, newText: only.content };
    }
    const message = `file does not exist — got op "${only.op}", expected "create" or "write"`;
    return failWithMiss({
      file: only.file,
      hunkIndex: 0,
      op: only.op,
      kind: "other",
      needle: "",
      matchCount: 0,
      fileText: "",
      message,
    });
  }

  // Path B: file exists. Walk the hunks in order, mutating the working
  // text each step.
  let text = currentText;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    switch (h.op) {
      case "create":
        return failWithMiss({
          file: h.file,
          hunkIndex: i,
          op: h.op,
          kind: "other",
          needle: "",
          matchCount: 0,
          fileText: text,
          message: `hunk[${i}] op "create": file already exists — use "replace", "replace_between", "write", or "append"`,
        });
      case "write":
        text = h.content;
        break;
      case "append":
        text = text + h.content;
        break;
      case "delete":
        // Delete the file — return empty string to signal deletion
        return { ok: true, newText: "" };
      case "replace_between": {
        let start = h.start;
        if (!start) {
          return failWithMiss({
            file: h.file,
            hunkIndex: i,
            op: h.op,
            kind: "other",
            needle: "",
            matchCount: 0,
            fileText: text,
            message: `hunk[${i}] op "replace_between": empty "start" marker`,
          });
        }
        let startCount = countOccurrences(text, start);

        // Same trailing-trim / CRLF normalize as replace.search.
        if (startCount === 0) {
          const normalized = normalizeSearchWhitespace(start);
          if (normalized !== start) {
            const normCount = countOccurrences(text, normalized);
            if (normCount === 1) {
              start = normalized;
              startCount = 1;
            }
          }
        }

        if (startCount === 0) {
          const message = `hunk[${i}] op "replace_between": "start" text not found in file`;
          return failWithMiss({
            file: h.file,
            hunkIndex: i,
            op: h.op,
            kind: "start_not_found",
            needle: start,
            matchCount: 0,
            fileText: text,
            message,
            focusOffset: null,
          });
        }
        if (startCount > 1) {
          const message = `hunk[${i}] op "replace_between": "start" text matches ${startCount} times — must be unique; add surrounding context`;
          return failWithMiss({
            file: h.file,
            hunkIndex: i,
            op: h.op,
            kind: "start_not_unique",
            needle: start,
            matchCount: startCount,
            fileText: text,
            message,
            // first match for nearby excerpt
            focusOffset: text.indexOf(start),
          });
        }
        const startIdx = text.indexOf(start);
        let endIdx = text.length;
        if (h.endExclusive != null && h.endExclusive.length > 0) {
          let end = h.endExclusive;
          const from = startIdx + start.length;
          let rel = text.indexOf(end, from);
          // Port trailing-trim / CRLF normalize to endExclusive.
          // Reject empty normalized needles: indexOf("", from) always
          // returns `from`, which would falsely "match" and collapse the
          // replace range to just the start marker (silent wrong apply).
          if (rel === -1) {
            const normalizedEnd = normalizeSearchWhitespace(end);
            if (normalizedEnd.length > 0 && normalizedEnd !== end) {
              rel = text.indexOf(normalizedEnd, from);
              if (rel !== -1) {
                end = normalizedEnd;
              }
            }
          }
          if (rel === -1) {
            const message = `hunk[${i}] op "replace_between": "endExclusive" text not found after start`;
            return failWithMiss({
              file: h.file,
              hunkIndex: i,
              op: h.op,
              kind: "end_not_found",
              needle: end,
              matchCount: 0,
              fileText: text,
              message,
              // Best guess: around start (section we were trying to bound).
              focusOffset: startIdx,
            });
          }
          // endExclusive must not appear again between start and first end if we want unique section;
          // first match after start is the section boundary (heading-style usage).
          endIdx = rel;
        }
        text = text.slice(0, startIdx) + h.replace + text.slice(endIdx);
        break;
      }
      case "replace": {
        let search = h.search;
        let count = countOccurrences(text, search);

        // Fuzzy fallback: trailing whitespace and line-ending drift are
        // the most common source of search mismatches. Try normalized
        // matching before giving up.
        if (count === 0) {
          const normalized = normalizeSearchWhitespace(search);
          if (normalized !== search) {
            const normCount = countOccurrences(text, normalized);
            if (normCount === 1) {
              search = normalized;
              count = 1;
            }
          }
        }

        if (count === 0) {
          const message = `hunk[${i}] op "replace": "search" text not found in file`;
          return failWithMiss({
            file: h.file,
            hunkIndex: i,
            op: h.op,
            kind: "search_not_found",
            needle: search,
            matchCount: 0,
            fileText: text,
            message,
            focusOffset: null,
          });
        }
        if (count > 1) {
          // Fail-closed multi-match (RR-A): never auto-apply a unique
          // line-suffix — that can hit the wrong occurrence. uniqueCandidates
          // on the miss report guide grounded repair instead.
          const message = `hunk[${i}] op "replace": "search" text matches ${count} times — must be unique; add surrounding context`;
          return failWithMiss({
            file: h.file,
            hunkIndex: i,
            op: h.op,
            kind: "search_not_unique",
            needle: search,
            matchCount: count,
            fileText: text,
            message,
            focusOffset: text.indexOf(search),
          });
        }
        const idx = text.indexOf(search);
        text = text.slice(0, idx) + h.replace + text.slice(idx + search.length);
        break;
      }
      default: {
        // Exhaustiveness check — TypeScript should prevent this reaching
        // runtime, but fail loud just in case a new op is added without
        // updating the switch.
        const never: never = h;
        const message = `unknown hunk op: ${JSON.stringify(never)}`;
        return failWithMiss({
          file: "",
          hunkIndex: i,
          op: "unknown",
          kind: "other",
          needle: "",
          matchCount: 0,
          fileText: text,
          message,
        });
      }
    }
  }
  return { ok: true, newText: text };
}

// Apply a batch of hunks that may target multiple files. Groups by file,
// dispatches to applyFileHunks per group, and returns the updated text for
// every touched file. Files with zero hunks are NOT included in the output
// (callers shouldn't need to write them).
export function applyHunks(
  currentTextsByFile: Record<string, string | null>,
  hunks: Hunk[],
): ApplyResult {
  if (hunks.length === 0) {
    return { ok: true, newTextsByFile: {} };
  }

  // Preserve first-seen order so deterministic error messages reference the
  // same hunk ordering the worker produced.
  const grouped = new Map<string, Hunk[]>();
  for (const h of hunks) {
    if (!grouped.has(h.file)) grouped.set(h.file, []);
    grouped.get(h.file)!.push(h);
  }

  const out: Record<string, string> = {};
  for (const [file, fileHunks] of grouped) {
    if (!(file in currentTextsByFile)) {
      const message = `hunk references file "${file}" which was not provided in currentTextsByFile`;
      return {
        ok: false,
        error: message,
        miss: buildApplyMissReport({
          file,
          hunkIndex: 0,
          op: fileHunks[0]?.op ?? "unknown",
          kind: "other",
          needle: "",
          matchCount: 0,
          fileText: "",
          message,
        }),
      };
    }
    const r = applyFileHunks(currentTextsByFile[file], fileHunks);
    if (!r.ok) {
      return {
        ok: false,
        error: `file "${file}": ${r.error}`,
        miss: r.miss,
      };
    }
    out[file] = r.newText;
  }
  return { ok: true, newTextsByFile: out };
}

// countOccurrences imported from applyMissReport (shared non-overlapping
// literal count used by apply + unique-candidate helpers).
