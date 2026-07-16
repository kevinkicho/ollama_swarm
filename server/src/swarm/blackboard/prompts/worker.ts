import { z } from "zod";
import type { Hunk } from "../applyHunks.js";
import {
  windowFileForWorker,
  windowFileWithAnchors,
  WORKER_FILE_WINDOW_THRESHOLD,
} from "../windowFile.js";
import type { RoundRobinDisposition } from "../../roundRobinPromptHelpers.js";
import { parseJsonEnvelope } from "@ollama-swarm/shared/parseAgentJson";
import { softCap } from "./lenientParse.js";
import { buildResearchNotesBlock, buildResearchToolsNote } from "./planner.js";
import { buildBlackboardDirectiveBlock } from "../../directivePromptHelpers.js";
import { hostToolingConstraintLines, JSON_ONLY_FINAL_RULE_LINES } from "./sharedSnippets.js";

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
export const SEARCH_MAX = 100_000;
export const REPLACE_MAX = 100_000;
export const CONTENT_MAX = 400_000;

/** Soft cap — oversized replace blocks risk apply failures and provider timeouts. */
export const HUNK_REPLACE_SOFT_MAX = 32_000;

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

const WriteHunkSchema = z.object({
  op: z.literal("write"),
  file: FILE_FIELD,
  content: z.string().max(CONTENT_MAX),
});

const ReplaceBetweenHunkSchema = z.object({
  op: z.literal("replace_between"),
  file: FILE_FIELD,
  start: z.string().min(1).max(SEARCH_MAX),
  endExclusive: z.string().min(1).max(SEARCH_MAX).optional(),
  replace: z.string().max(CONTENT_MAX),
});

const DeleteHunkSchema = z.object({
  op: z.literal("delete"),
  file: FILE_FIELD,
});

const HunkSchema = z.discriminatedUnion("op", [
  ReplaceHunkSchema,
  CreateHunkSchema,
  AppendHunkSchema,
  WriteHunkSchema,
  ReplaceBetweenHunkSchema,
  DeleteHunkSchema,
]);

// Per-response hunk budget. 8 lets a worker make several focused edits to a
// large file (e.g. README troubleshooting + routing section + provider note)
// without needing to bundle them into one giant replace block.
export const MAX_HUNKS = 16;

export const WorkerResponseSchema = z.object({
  hunks: z.array(HunkSchema).max(MAX_HUNKS),
  skip: z.string().trim().min(1).max(500).optional(),
});

export type WorkerParseResult =
  | { ok: true; hunks: Hunk[]; skip?: string }
  | { ok: false; reason: string };

/** Reject hunks whose replace payload is too large for reliable apply. */
export function validateHunkPayload(hunks: readonly Hunk[]): WorkerParseResult {
  for (const h of hunks) {
    if (h.op === "replace") {
      const size = h.search.length + h.replace.length;
      if (size > HUNK_REPLACE_SOFT_MAX) {
        return {
          ok: false,
          reason:
            `replace hunk on "${h.file}" is ${size} chars (soft max ${HUNK_REPLACE_SOFT_MAX}) — use op "replace_between" or "write", or split into smaller section edits`,
        };
      }
    }
    // write / replace_between are the intentional bulk path — only hard schema max applies.
    if (h.op === "create" && h.content.length > HUNK_REPLACE_SOFT_MAX) {
      return {
        ok: false,
        reason:
          `create hunk on "${h.file}" is ${h.content.length} chars (soft max ${HUNK_REPLACE_SOFT_MAX}) — use op "write" for large new files or split`,
      };
    }
    if (h.op === "append" && h.content.length > HUNK_REPLACE_SOFT_MAX) {
      return {
        ok: false,
        reason:
          `append hunk on "${h.file}" is ${h.content.length} chars (soft max ${HUNK_REPLACE_SOFT_MAX}) — split into smaller appends`,
      };
    }
  }
  return { ok: true, hunks: [...hunks] };
}

export function parseWorkerResponse(
  raw: string,
  expectedFiles: string[],
): WorkerParseResult {
  if (raw.trim().length === 0) {
    return { ok: false, reason: "empty response — model produced no output after stripping thinking tags" };
  }
  const envelopeResult = parseJsonEnvelope(raw);
  if (!envelopeResult.ok) {
    return { ok: false, reason: envelopeResult.reason };
  }
  const parsed = envelopeResult.value;

  // Try strict parse first; if it fails, attempt per-hunk extraction so one
  // bad hunk doesn't kill the whole response.
  const v = WorkerResponseSchema.safeParse(parsed);
  if (v.success) {
    const allowed = new Set(expectedFiles);
    for (const h of v.data.hunks) {
      if (!allowed.has(h.file)) {
        return { ok: false, reason: `hunk file "${h.file}" not in expectedFiles` };
      }
    }
    return { ok: true, hunks: v.data.hunks as Hunk[], skip: v.data.skip };
  }

  // Lenient path: try to extract partial valid hunks from the parsed object.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const reason = v.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }

  const envelope = parsed as Record<string, unknown>;
  const rawHunks = Array.isArray(envelope.hunks) ? envelope.hunks as unknown[] : [];
  if (rawHunks.length === 0 && typeof envelope.skip !== "string") {
    const reason = v.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }

  const allowed = new Set(expectedFiles);
  const validHunks: Hunk[] = [];
  for (const h of softCap(rawHunks, MAX_HUNKS)) {
    const hv = HunkSchema.safeParse(h);
    if (!hv.success) continue;
    if (!allowed.has(hv.data.file)) continue;
    validHunks.push(hv.data as Hunk);
  }

  const skip = typeof envelope.skip === "string" && envelope.skip.trim().length > 0
    ? envelope.skip.trim().slice(0, 500)
    : undefined;

  if (validHunks.length === 0 && !skip) {
    const reason = v.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }

  return { ok: true, hunks: validHunks, skip };
}

// ---------------------------------------------------------------------------
// Prompts.
// ---------------------------------------------------------------------------

export const WORKER_SYSTEM_PROMPT = [
  "You are a WORKER implementing one TODO via file hunks.",
  "",
  "RULES:",
  "1. Final response:",
  ...JSON_ONLY_FINAL_RULE_LINES.map((line) => `   ${line}`),
  "2. Shape: {\"hunks\": [...]}  — max " + String(MAX_HUNKS) + " hunks. Optional skip: {\"hunks\":[],\"skip\":\"reason\"}.",
  "3. Each hunk: `op` + `file`. `file` must be in the TODO's expectedFiles only.",
  "4. Ops:",
  "   - replace: {op,file,search,replace} — `search` must match EXACTLY ONCE (enough context to be unique).",
  "   - replace_between: {op,file,start,endExclusive?,replace} — prefer for large section rewrites; omit endExclusive for start→EOF.",
  "   - write: {op,file,content} — full rewrite or create when unsure.",
  "   - create: {op,file,content} — only if the file does not exist yet.",
  "   - append: {op,file,content} — end of file, no stable anchor.",
  "   - delete: {op,file} — only when the TODO requires removing the file.",
  "5. Hunks on one file apply in order. Missing expectedFiles → create them (do not skip). Skip only if verified already done or genuinely impossible.",
  "6. USER DIRECTIVE (when present) is authoritative — no mock/placeholder data; serve its intent.",
  "7. You may call propose_hunks mid-turn to dry-run anchors before the final JSON.",
  "8. After a search/start miss: re-read the file and copy a unique anchor — do not re-emit the failed search or claim already-done without reading.",
  ...hostToolingConstraintLines().map((line) => `   ${line}`),
  "",
  "WINDOWED files (large): head + gap + tail only — use replace_between/write or tools for middle sections; do not invent a search spanning the gap.",
  "",
  "EXAMPLES (shape only):",
  '{"hunks":[{"op":"replace","file":"src/utils.js","search":"function clamp(n, max) {\\n  return n > max ? max : n;\\n}","replace":"function clamp(n, max) {\\n  return n >= max ? max : n;\\n}"}]}',
  '{"hunks":[{"op":"create","file":"src/log.js","content":"export function log(msg) {\\n  console.log(`[app] ${msg}`);\\n}\\n"}]}',
  '{"hunks":[{"op":"append","file":"CHANGELOG.md","content":"\\n## v1.2.0\\n- Added clamp helper.\\n"}]}',
  "",
  "Avoid: non-unique search; literal newlines in JSON (use \\n); create on an existing file; fences/line numbers in output.",
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
  /** Unit X: the user directive from cfg.userDirective. When present, the worker
   *  must follow it. Absent when no directive was provided. */
  directive?: string;
  // Unit 59 (59a): worker role bias. When set, the runner prepends
  // this guidance to WORKER_SYSTEM_PROMPT before the rules so the
  // worker's diff carries the role's bias (correctness / simplicity /
  // consistency, etc. — see workerRoles.ts catalog). Absent on
  // default-pool runs; the worker prompt is byte-identical to the
  // pre-Unit-59 shape when omitted.
  roleGuidance?: string;
  // Plan 3: hot files from pheromone heatmap (prior stigmergy exploration).
  // When present, surfaces files that accumulated the most visits/interest/
  // confidence during a stigmergy run so the worker can prioritize them.
  hotFiles?: Array<{ path: string; score: number; visits: number; avgInterest: number; avgConfidence: number }>;
  // Plan 6: rotating disposition from round-robin, applied per cycle
  // so the same worker approaches todos from different angles.
  disposition?: RoundRobinDisposition;
  // Plan 2: optional files the worker needs to READ for context but
  // NOT modify. Rendered as read-only context in the prompt.
  contextFiles?: string[];
  // Plan 8: model context budget — controls whether full files are shown
  // or windowed. Derived from the model's context window size.
  fullFileMode?: boolean;
  /** When true, worker may use web_search/web_fetch before writing hunks. */
  webToolsEnabled?: boolean;
  /** Web research brief from a prior worker research phase or planner pre-pass. */
  researchNotes?: string;
  /** Mid-run suggest/ask messages from user chat (steer is in directive). */
  userChatBlock?: string;
  /** Existing API catalog + .env key names for dedup grounding. */
  endpointCatalogBlock?: string;
  /** Cross-run project knowledge graph slice. */
  projectGraphSlice?: string;
  /** Q11: few-shot similar past hunks from `.swarm-hunk-examples.jsonl`. */
  hunkRagBlock?: string;
}

/** Repo tools available to hunk workers (builder profile). */
export function buildWorkerToolsNote(): string {
  return [
    "=== AVAILABLE TOOLS ===",
    "You have read, grep, glob, list, bash, and propose_hunks (plus web tools when enabled).",
    "Use inspection tools when:",
    "  - expectedFiles are windowed and you need headings/anchors from the omitted middle",
    "  - you must verify an anchor is unique or exists",
    "  - you need to check for duplicate routes/endpoints/API keys elsewhere in the repo",
    "Use propose_hunks to dry-run or apply {hunks:[...]} mid-turn and receive apply feedback",
    "  (success preview, or failure with nearby file excerpt). Prefer replace_between/write for bulk edits.",
    "Final delivery is still a JSON {\"hunks\":[...]} response (or skip) so the runner can commit.",
    "=== end TOOLS NOTE ===",
  ].join("\n");
}

/**
 * Whether this todo needs a web literature pre-pass.
 *
 * Run eee6718f RCA: the old regex matched bare "source", "paper", "findings"
 * inside normal panel todos (e.g. COMMERCIAL_PAPER, "source: worldbank",
 * "data source health") and burned ~20 literature tool-loop failures per run.
 *
 * Require explicit research intent — not incidental vocabulary.
 */
export function isLiteratureTodo(description: string): boolean {
  const d = description.trim();
  if (!d) return false;
  // Explicit research / literature language
  if (
    /\b(literature\s+review|literature\s+research|web\s+research|web\s+search|desk\s+research)\b/i.test(d)
  ) {
    return true;
  }
  if (/\b(arxiv|citation|citations|bibliography|survey papers?)\b/i.test(d)) {
    return true;
  }
  // "research X" / "research and document" as a primary verb phrase near the start
  if (/^(research|survey|investigate)\b/i.test(d)) return true;
  if (/\b(research (the |and |official |API |endpoints?|sources?))\b/i.test(d)) return true;
  return false;
}

/**
 * Pull section/heading anchors from free-text todo descriptions so windowed
 * files get middle excerpts without requiring the planner to fill expectedAnchors.
 */
export function extractAnchorsFromTodoDescription(description: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const a = raw.trim();
    if (a.length < 3 || a.length > 120) return;
    if (seen.has(a)) return;
    seen.add(a);
    found.push(a);
  };
  // Markdown headings mentioned in the todo text
  for (const m of description.matchAll(/#{1,6}\s+[^\n"'`]{2,100}/g)) {
    push(m[0]);
  }
  // Quoted section titles often used in prose todos
  for (const m of description.matchAll(/['"](#{1,6}\s+[^'"]{2,100}|[A-Z][^'"]{2,80})['"]/g)) {
    push(m[1] ?? "");
  }
  return found.slice(0, 8);
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
  if (seed.disposition) {
    parts.push(`**${seed.disposition.name.toUpperCase()} DISPOSITION THIS CYCLE:** ${seed.disposition.framing}`);
    parts.push("");
  }
  if (seed.hotFiles && seed.hotFiles.length > 0) {
    parts.push("## Hot Files (from prior exploration)");
    parts.push("The following files were identified as most relevant by a prior exploration pass:");
    for (const hf of seed.hotFiles) {
      parts.push(`  ${hf.path} (score: ${hf.score.toFixed(1)}, interest: ${hf.avgInterest.toFixed(0)}, confidence: ${hf.avgConfidence.toFixed(0)})`);
    }
    parts.push("");
  }
  if (seed.projectGraphSlice && seed.projectGraphSlice.trim().length > 0) {
    parts.push(seed.projectGraphSlice.trim());
    parts.push("");
  }
  if (seed.hunkRagBlock && seed.hunkRagBlock.trim().length > 0) {
    parts.push(seed.hunkRagBlock.trim());
    parts.push("");
  }
  const directiveLines = buildBlackboardDirectiveBlock(seed.directive, {
    labelSuffix: "(AUTHORITATIVE — your work MUST serve this directive. Never create mock/fake/placeholder data.)",
    authoritative: true,
    includeAuthoritativeFraming: false,
  });
  if (directiveLines.length > 0) {
    parts.push("");
    parts.push(...directiveLines);
  }
  if (seed.userChatBlock && seed.userChatBlock.trim().length > 0) {
    parts.push(seed.userChatBlock.trim());
    parts.push("");
  }
  parts.push(buildWorkerToolsNote());
  parts.push("");
  if (seed.endpointCatalogBlock && seed.endpointCatalogBlock.trim().length > 0) {
    parts.push(seed.endpointCatalogBlock.trim());
    parts.push("");
  }
  if (seed.webToolsEnabled) {
    const toolsNote = buildResearchToolsNote(true);
    if (toolsNote) {
      parts.push(toolsNote);
      parts.push("");
      parts.push(
        "For literature/research TODOs: use web_search + web_fetch to gather citable sources, then write hunks that document findings with URLs in the target files.",
      );
      parts.push("");
    }
  }
  parts.push(buildResearchNotesBlock(seed.researchNotes));
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
    } else if (seed.fullFileMode && content.length > WORKER_FILE_WINDOW_THRESHOLD) {
      // Plan 8: large-context models see full file content — this takes
      // priority over anchored view, since the model can handle the full file.
      parts.push(`=== Current contents of ${f} (${content.length} chars, full) ===`);
      parts.push(content);
      parts.push(`=== end ${f} ===`);
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
  // Plan 2: render context files as read-only reference
  if (seed.contextFiles && seed.contextFiles.length > 0) {
    parts.push("=== READ-ONLY CONTEXT FILES (do NOT modify these — reference only) ===");
    for (const f of seed.contextFiles) {
      const content = seed.fileContents[f];
      if (content === null || content === undefined) {
        parts.push(`=== ${f} (does not exist on disk — reference only) ===`);
      } else {
        const view = windowFileForWorker(content);
        const header = view.full
          ? `=== ${f} (${content.length} chars, full) ===`
          : `=== ${f} (${content.length} chars, WINDOWED) ===`;
        parts.push(header);
        parts.push(view.content);
        parts.push(`=== end ${f} ===`);
      }
      parts.push("");
    }
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

// Task #78 (2026-04-25): self-repair when applyHunks fails because a
// `search` text doesn't exactly match the file (whitespace drift, tab
// vs spaces, CRLF vs LF, the model imagined a slightly-different
// version of the file). Prior behavior: markStale → replan from
// scratch with a fresh worker. Now: feed the actual file content +
// the failed hunks back to the SAME worker once before giving up.
//
// Cap at HUNK_REPAIR_FILE_SLICE chars — most worker turns are
// surgical and the worker doesn't need the whole 50KB file to fix
// one hunk. If the file is larger we send head+tail.
const HUNK_REPAIR_FILE_SLICE = 8_000;

export function buildHunkRepairPrompt(
  failedHunks: unknown[],
  applyError: string,
  fileContents: Record<string, string>,
): string {
  const fileBlocks: string[] = [];
  for (const [file, contents] of Object.entries(fileContents)) {
    let body = contents;
    let note = "";
    if (contents.length > HUNK_REPAIR_FILE_SLICE * 2) {
      const head = contents.slice(0, HUNK_REPAIR_FILE_SLICE).trimEnd();
      const tail = contents.slice(-HUNK_REPAIR_FILE_SLICE).trimStart();
      body = `${head}\n\n... <middle ${contents.length - HUNK_REPAIR_FILE_SLICE * 2} chars elided> ...\n\n${tail}`;
      note = " (showing head + tail; middle elided)";
    }
    fileBlocks.push(`--- BEGIN FILE: ${file}${note} ---\n${body}\n--- END FILE: ${file} ---`);
  }
  return [
    "Your previous diff did NOT apply to the file. The most common cause is a whitespace or newline mismatch — your `search` text doesn't exactly match what's actually in the file.",
    `applyHunks error: ${applyError}`,
    "",
    "The ACTUAL current file content is below. Compare your search text to the real bytes — note exact whitespace, tabs vs spaces, blank lines.",
    "",
    ...fileBlocks,
    "",
    "Your previous hunks were:",
    "--- BEGIN PREVIOUS HUNKS ---",
    JSON.stringify(failedHunks, null, 2),
    "--- END PREVIOUS HUNKS ---",
    "",
    "Respond NOW with a corrected JSON envelope. The `search` field must be a verbatim substring of the file content shown above. Match exact whitespace.",
    "",
    'Shape: {"hunks": [{"op": "replace", "file": "path", "search": "exact old text", "replace": "new text"}]}',
    "No prose. No markdown fences. Just the JSON object.",
  ].join("\n");
}
