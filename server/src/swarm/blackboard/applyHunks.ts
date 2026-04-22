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
// Three ops: replace (the common case), create (new file), append (end-of-file
// additions where there's no stable anchor to replace against, e.g. CHANGELOG
// entries). That's enough to cover everything workers actually need.
//
// This module is pure + side-effect free + unit-testable. The runner groups
// worker-emitted hunks by file, reads the current file content, calls
// applyFileHunks, and then CAS-writes the result.

export type Hunk =
  | { op: "replace"; file: string; search: string; replace: string }
  | { op: "create"; file: string; content: string }
  | { op: "append"; file: string; content: string };

export type ApplyFileResult =
  | { ok: true; newText: string }
  | { ok: false; error: string };

export type ApplyResult =
  | { ok: true; newTextsByFile: Record<string, string> }
  | { ok: false; error: string };

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

  // Path A: file didn't exist yet. The only valid shape is exactly one
  // "create" hunk. Anything else is a programming error (the worker doesn't
  // know the file state; the runner does).
  if (currentText === null) {
    if (hunks.length !== 1) {
      return {
        ok: false,
        error: `file does not exist — expected exactly one "create" hunk, got ${hunks.length}`,
      };
    }
    const only = hunks[0];
    if (only.op !== "create") {
      return {
        ok: false,
        error: `file does not exist — got op "${only.op}", expected "create"`,
      };
    }
    return { ok: true, newText: only.content };
  }

  // Path B: file exists. Walk the hunks in order, mutating the working
  // text each step.
  let text = currentText;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    switch (h.op) {
      case "create":
        return {
          ok: false,
          error: `hunk[${i}] op "create": file already exists — use "replace" or "append"`,
        };
      case "append":
        text = text + h.content;
        break;
      case "replace": {
        const count = countOccurrences(text, h.search);
        if (count === 0) {
          return {
            ok: false,
            error: `hunk[${i}] op "replace": "search" text not found in file`,
          };
        }
        if (count > 1) {
          return {
            ok: false,
            error: `hunk[${i}] op "replace": "search" text matches ${count} times — must be unique; add surrounding context`,
          };
        }
        const idx = text.indexOf(h.search);
        text = text.slice(0, idx) + h.replace + text.slice(idx + h.search.length);
        break;
      }
      default: {
        // Exhaustiveness check — TypeScript should prevent this reaching
        // runtime, but fail loud just in case a new op is added without
        // updating the switch.
        const never: never = h;
        return { ok: false, error: `unknown hunk op: ${JSON.stringify(never)}` };
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
      return {
        ok: false,
        error: `hunk references file "${file}" which was not provided in currentTextsByFile`,
      };
    }
    const r = applyFileHunks(currentTextsByFile[file], fileHunks);
    if (!r.ok) {
      return { ok: false, error: `file "${file}": ${r.error}` };
    }
    out[file] = r.newText;
  }
  return { ok: true, newTextsByFile: out };
}

// Simple non-overlapping occurrence count. We don't need regex — search
// text is literal, and the schema has already rejected empty strings.
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
