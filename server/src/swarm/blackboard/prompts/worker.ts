import { z } from "zod";
import type { Hunk } from "../applyHunks.js";
import { windowFileForWorker, windowFileWithAnchors } from "../windowFile.js";

// ---------------------------------------------------------------------------
// Worker response schema (v2). Shape: {"hunks": [ ...discriminated on op ]}.
//
// v1 was full-file replacement ({file, newText}) — simple but quadratic on big
// files: the worker reads a 49KB README in the prompt and sends it back, every
// time, even for a two-line edit. Combined with cloud LLM latency that blew
// past undici's 5-min header timeout (phase11c-medium-v5, c2 unmet).
//
// v2 is Aider-style search/replace. Three ops: replace (the common case),
// create (new file), append (end-of-file with no stable anchor, e.g. CHANGELOG
// entries). The runner enforces exact-single-match on replace and fails closed
// with a clear reason on ambiguity.
// ---------------------------------------------------------------------------

const FILE_FIELD = z.string().trim().min(1).max(1000);

// Per-field caps. Search/replace are kept modest because a giant search block
// is almost always the worker trying to re-paste a whole file — the point of
// hunks is NOT to do that. Create/append can legitimately be larger (new
// scaffolding file, long CHANGELOG entry), but we still cap to prevent a
// runaway model from buying us half a gigabyte of prose.
const SEARCH_MAX = 50_000;
const REPLACE_MAX = 50_000;
const CONTENT_MAX = 200_000;

const ReplaceHunkSchema = z.object({
  op: z.literal("replace"),
  file: FILE_FIELD,
  // search must be non-empty — an empty anchor matches nothing / everything
  // depending on interpretation, and applyHunks rejects it anyway.
  search: z.string().min(1).max(SEARCH_MAX),
  // replace may be empty — that's a legitimate deletion.
  replace: z.string().max(REPLACE_MAX),
});

const CreateHunkSchema = z.object({
  op: z.literal("create"),
  file: FILE_FIELD,
  // content may be empty — creating an empty file is legal (e.g. placeholder).
  content: z.string().max(CONTENT_MAX),
});

const AppendHunkSchema = z.object({
  op: z.literal("append"),
  file: FILE_FIELD,
  // append with empty content is a no-op; reject at parse time so the worker
  // can't accidentally burn a hunk slot on nothing.
  content: z.string().min(1).max(CONTENT_MAX),
});

const HunkSchema = z.discriminatedUnion("op", [
  ReplaceHunkSchema,
  CreateHunkSchema,
  AppendHunkSchema,
]);

// Per-response hunk budget. 8 lets a worker make several focused edits to a
// large file (e.g. README troubleshooting + routing section + provider note)
// without needing to bundle them into one giant replace block.
const MAX_HUNKS = 8;

const WorkerResponseSchema = z.object({
  hunks: z.array(HunkSchema).max(MAX_HUNKS),
  skip: z.string().trim().min(1).max(500).optional(),
});

export type WorkerParseResult =
  | { ok: true; hunks: Hunk[]; skip?: string }
  | { ok: false; reason: string };

// Same extraction pattern as planner.ts: try strict JSON.parse first so a
// perfectly-shaped top-level object isn't chewed into something else by the
// fallback heuristics. Only if that fails do we try fence-stripping.
function stripFences(raw: string): string | null {
  const s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  const innerFence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (innerFence) return innerFence[1].trim();
  // Prose-then-object: slice between first '{' and last '}'. Only meaningful
  // if there's prose before the opening brace; otherwise it'd just re-return s.
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) {
    return s.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

export function parseWorkerResponse(
  raw: string,
  expectedFiles: string[],
): WorkerParseResult {
  let parsed: unknown;
  let lastError = "";
  try {
    parsed = JSON.parse(raw.trim());
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    const cleaned = stripFences(raw);
    if (cleaned === null) {
      return { ok: false, reason: `JSON parse failed: ${lastError}` };
    }
    try {
      parsed = JSON.parse(cleaned);
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      return { ok: false, reason: `JSON parse failed: ${msg}` };
    }
  }

  const v = WorkerResponseSchema.safeParse(parsed);
  if (!v.success) {
    const reason = v.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }

  // Workers must stay inside the TODO's expectedFiles. Anything else is a bug
  // or a prompt-injection attempt, and either way the runner shouldn't have
  // to decide what to do with it. Unlike v1, multiple hunks per file are now
  // expected (that's the whole point) — don't reject on duplicate file.
  const allowed = new Set(expectedFiles);
  for (const h of v.data.hunks) {
    if (!allowed.has(h.file)) {
      return { ok: false, reason: `hunk file "${h.file}" not in expectedFiles` };
    }
  }

  return { ok: true, hunks: v.data.hunks as Hunk[], skip: v.data.skip };
}

// ---------------------------------------------------------------------------
// Prompts.
// ---------------------------------------------------------------------------

export const WORKER_SYSTEM_PROMPT = [
  "You are a WORKER agent in a swarm. You are implementing a single TODO from the shared board.",
  "",
  "HARD RULES:",
  "1. Output ONLY a JSON object. No prose. No markdown fences. No commentary before or after.",
  "2. Shape: {\"hunks\": [ ...search/replace hunks ]}",
  "3. Each hunk has an `op` and a `file`. `file` MUST be one of the paths in the TODO's expectedFiles list — do not touch any other file.",
  "4. Three ops, pick the right one for each change:",
  "   - {\"op\": \"replace\", \"file\": \"...\", \"search\": \"<EXACT text to find>\", \"replace\": \"<new text>\"}",
  "     The `search` text must appear EXACTLY ONCE in the current file. Include enough surrounding context to be unique. If the same phrase appears twice, extend `search` until it's unique — otherwise the hunk is rejected.",
  "   - {\"op\": \"create\", \"file\": \"...\", \"content\": \"<entire file contents>\"}",
  "     Only valid when the file does not yet exist. Use this for scaffolding new files.",
  "   - {\"op\": \"append\", \"file\": \"...\", \"content\": \"<text to append at end of file>\"}",
  "     Use when you need to add at the very end and there's no stable anchor to replace (e.g. appending a new CHANGELOG entry).",
  "5. Multiple hunks per file are allowed and applied in order — each hunk sees the output of the previous one.",
  "6. If the TODO is impossible, unsafe, or already done, respond with: {\"hunks\": [], \"skip\": \"brief reason\"}",
  "7. Maximum 8 hunks per response.",
  "",
  "You will be given the TODO description, the expected file paths, and the current contents of each file (or a note that it does not exist).",
  "",
  "LARGE FILES: any file above 8000 chars is shown WINDOWED — you will see the first 3000 chars, a marker noting how many chars are omitted, then the last 3000 chars. To edit text in the omitted middle region, either use op \"append\" for end-of-file additions, or use op \"replace\" with a \"search\" anchor that is unique and visible in the shown head or tail. Do not try to reproduce the whole file back — use hunks.",
].join("\n");

export interface WorkerSeed {
  todoId: string;
  description: string;
  expectedFiles: string[];
  // null = file does not exist on disk (worker is creating it).
  fileContents: Record<string, string | null>;
  // Unit 44b: planner-declared anchor strings to surface around their
  // match locations in the worker prompt. Resolved per-file at prompt
  // build time. When absent or empty, falls back to the head + tail
  // window from windowFileForWorker.
  expectedAnchors?: string[];
  // Unit 59 (59a): worker role bias. When set, the runner prepends
  // this guidance to WORKER_SYSTEM_PROMPT before the rules so the
  // worker's diff carries the role's bias (correctness / simplicity /
  // consistency, etc. — see workerRoles.ts catalog). Absent on
  // default-pool runs; the worker prompt is byte-identical to the
  // pre-Unit-59 shape when omitted.
  roleGuidance?: string;
}

export function buildWorkerUserPrompt(seed: WorkerSeed): string {
  const anchors = seed.expectedAnchors ?? [];
  const parts: string[] = [];
  // Unit 59 (59a): role guidance leads the prompt so the worker reads
  // its bias before the todo. Only present when specializedWorkers
  // mode is on; absent renders the pre-Unit-59 shape verbatim.
  if (seed.roleGuidance && seed.roleGuidance.trim().length > 0) {
    parts.push(seed.roleGuidance.trim());
    parts.push("");
  }
  parts.push(`TODO: ${seed.description}`);
  parts.push(`Expected files: ${seed.expectedFiles.join(", ")}`);
  if (anchors.length > 0) {
    parts.push(`Expected anchors (Unit 44b): ${anchors.map((a) => JSON.stringify(a)).join(", ")}`);
  }
  parts.push("");
  for (const f of seed.expectedFiles) {
    const content = seed.fileContents[f];
    if (content === null || content === undefined) {
      parts.push(`=== ${f} (does not exist — use op "create") ===`);
    } else if (anchors.length > 0) {
      // Unit 44b: anchored view per file. Includes head + per-anchor
      // excerpts + tail when the file is large; behaves like the basic
      // windowed view when it isn't. The per-anchor report is appended
      // to the header so the model knows which anchors were resolved.
      const view = windowFileWithAnchors(content, anchors);
      const headerMode = view.full
        ? "full"
        : "ANCHORED — head + per-anchor excerpts + tail";
      const reportSummary = view.anchorReports
        .map((r) => `${JSON.stringify(r.anchor)}=${r.found === null ? "MISS" : `line ${r.found}`}`)
        .join(", ");
      parts.push(
        `=== Current contents of ${f} (${content.length} chars, ${headerMode}) [anchors: ${reportSummary}] ===`,
      );
      parts.push(view.content);
      parts.push(`=== end ${f} ===`);
    } else {
      const view = windowFileForWorker(content);
      const header = view.full
        ? `=== Current contents of ${f} (${content.length} chars, full) ===`
        : `=== Current contents of ${f} (${content.length} chars, WINDOWED — head + marker + tail) ===`;
      parts.push(header);
      parts.push(view.content);
      parts.push(`=== end ${f} ===`);
    }
    parts.push("");
  }
  parts.push(
    "Output your JSON now. Use search/replace hunks — do NOT paste whole files back. JSON only.",
  );
  return parts.join("\n");
}

export function buildWorkerRepairPrompt(previousResponse: string, parseError: string): string {
  return [
    "Your previous response could not be parsed as the required JSON object.",
    `Parser error: ${parseError}`,
    "",
    "Your previous response was:",
    "--- BEGIN PREVIOUS RESPONSE ---",
    previousResponse,
    "--- END PREVIOUS RESPONSE ---",
    "",
    "Respond now with ONLY a JSON object matching:",
    '{"hunks": [{"op": "replace", "file": "path", "search": "exact old text", "replace": "new text"}]}',
    "",
    "Other valid op shapes: create ({op:\"create\", file, content}), append ({op:\"append\", file, content}).",
    "No prose. No markdown fences. No commentary. Just the JSON object.",
  ].join("\n");
}
