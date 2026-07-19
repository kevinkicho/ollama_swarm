import { z } from "zod";
import type { Hunk } from "../applyHunks.js";
import type { ApplyMissReport } from "../applyMissReport.js";
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
import { hostToolingConstraintLines } from "./sharedSnippets.js";

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
  // Models often emit "endExclusive": null for start→EOF; treat as omitted
  // (2010479c: "Expected string, received null" → wasted repair turns).
  endExclusive: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.string().min(1).max(SEARCH_MAX).optional(),
  ),
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
  | {
      ok: true;
      hunks: Hunk[];
      skip?: string;
      demotions?: HunkDemotion[];
      /** Git-native: worker mutated working tree via write/edit tools. */
      workingTree?: boolean;
      gitMessage?: string;
      filesTouched?: string[];
    }
  | { ok: false; reason: string };

/** Record of an automatic op demotion for oversized payloads (83dc5910). */
export interface HunkDemotion {
  file: string;
  from: "replace" | "create";
  to: "write" | "replace_between";
  size: number;
  reason: string;
}

/**
 * Auto-demote oversized replace/create hunks so workers don't thrash on
 * soft-max rejections (live: tab-expansion replaces of 30k+ chars).
 *
 * Policy:
 *   - replace → replace_between (first/last line of search as anchors), or
 *     write when the edit looks like a full-file rewrite / missing file
 *   - create → write (same content; create is wrong when body is huge)
 *   - append stays fail-closed (no safe demotion)
 */
export function demoteOversizedHunks(
  hunks: readonly Hunk[],
  fileContents?: Record<string, string | null>,
): { hunks: Hunk[]; demotions: HunkDemotion[] } {
  const out: Hunk[] = [];
  const demotions: HunkDemotion[] = [];
  for (const h of hunks) {
    if (h.op === "replace") {
      const size = h.search.length + h.replace.length;
      if (size <= HUNK_REPLACE_SOFT_MAX) {
        out.push(h);
        continue;
      }
      const fileText = fileContents?.[h.file] ?? fileContents?.[normalizeRepoPath(h.file)] ?? null;
      const demoted = demoteReplaceHunk(h, fileText);
      demotions.push({
        file: h.file,
        from: "replace",
        to: demoted.to,
        size,
        reason: demoted.reason,
      });
      out.push(demoted.hunk);
      continue;
    }
    if (h.op === "create" && h.content.length > HUNK_REPLACE_SOFT_MAX) {
      demotions.push({
        file: h.file,
        from: "create",
        to: "write",
        size: h.content.length,
        reason: `oversized create (${h.content.length} chars) → write`,
      });
      out.push({ op: "write", file: h.file, content: h.content });
      continue;
    }
    out.push(h);
  }
  return { hunks: out, demotions };
}

function demoteReplaceHunk(
  h: Extract<Hunk, { op: "replace" }>,
  fileText: string | null,
): { hunk: Hunk; to: "write" | "replace_between"; reason: string } {
  const { file, search, replace } = h;

  // Missing file: write the replacement body as the new file.
  if (fileText == null || fileText.length === 0) {
    return {
      hunk: { op: "write", file, content: replace },
      to: "write",
      reason: "oversized replace on missing/empty file → write",
    };
  }

  // Full-file rewrite signals: replacement ≈ whole file, or search covers most of it.
  const searchInFile = fileText.includes(search);
  if (
    replace.length >= fileText.length * 0.7
    || (searchInFile && search.length >= fileText.length * 0.5)
  ) {
    return {
      hunk: { op: "write", file, content: replace },
      to: "write",
      reason: "oversized replace looks like full-file rewrite → write",
    };
  }

  // Multi-line search → section replace_between with first/last line anchors.
  const lines = search.split("\n").map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.length > 0);
  if (nonEmpty.length >= 2) {
    let start = nonEmpty[0]!;
    let endExclusive = nonEmpty[nonEmpty.length - 1]!;
    // Keep anchors modest so apply isn't brittle on huge first lines.
    if (start.length > 400) start = start.slice(0, 400);
    if (endExclusive.length > 400) endExclusive = endExclusive.slice(0, 400);
    if (start === endExclusive) {
      return {
        hunk: { op: "replace_between", file, start, replace },
        to: "replace_between",
        reason: "oversized replace → replace_between (start→EOF)",
      };
    }
    return {
      hunk: { op: "replace_between", file, start, endExclusive, replace },
      to: "replace_between",
      reason: "oversized replace → replace_between (first/last line anchors)",
    };
  }

  // Single-line search + huge replace: anchor → EOF section rewrite.
  let start = search;
  if (start.length > 400) start = start.slice(0, 400);
  return {
    hunk: { op: "replace_between", file, start, replace },
    to: "replace_between",
    reason: "oversized replace → replace_between (anchor→EOF)",
  };
}

/**
 * Normalize oversized payloads (auto-demote replace/create) then fail-closed
 * only on ops we cannot safely demote (oversized append).
 */
export function validateHunkPayload(
  hunks: readonly Hunk[],
  fileContents?: Record<string, string | null>,
): WorkerParseResult {
  const { hunks: demoted, demotions } = demoteOversizedHunks(hunks, fileContents);
  for (const h of demoted) {
    if (h.op === "append" && h.content.length > HUNK_REPLACE_SOFT_MAX) {
      return {
        ok: false,
        reason:
          `append hunk on "${h.file}" is ${h.content.length} chars (soft max ${HUNK_REPLACE_SOFT_MAX}) — split into smaller appends`,
      };
    }
  }
  return {
    ok: true,
    hunks: demoted,
    demotions: demotions.length > 0 ? demotions : undefined,
  };
}

/** Normalize repo-relative paths for expectedFiles allow-list matching. */
export function normalizeRepoPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    // Live 4de10651: models emit absolute-looking "/24_module.html" roots.
    .replace(/^\/+/, "")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .trim();
}

function allowedFileSet(expectedFiles: readonly string[]): Set<string> {
  return new Set(expectedFiles.map(normalizeRepoPath).filter(Boolean));
}

/**
 * When expectedFiles is empty, allow any path.
 * Non-empty lists prefer the allow-list but **soft-accept** same-directory
 * or same-basename paths so multi-file work is not hard-blocked
 * (runs 4bd7f7f6 / design brain-os). Strict mode: set SWARM_STRICT_EXPECTED_FILES=1.
 */
function fileAllowed(
  file: string,
  allowed: Set<string>,
  allowAll: boolean,
): boolean {
  if (allowAll) return true;
  const norm = normalizeRepoPath(file);
  if (allowed.has(norm)) return true;
  if (process.env.SWARM_STRICT_EXPECTED_FILES === "1") return false;
  // Soft fence: same directory as an expected file, or basename match.
  const base = norm.split("/").pop() ?? norm;
  const dir = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
  for (const a of allowed) {
    const aBase = a.split("/").pop() ?? a;
    const aDir = a.includes("/") ? a.slice(0, a.lastIndexOf("/")) : "";
    if (base && base === aBase) return true;
    if (dir && aDir && dir === aDir) return true;
    // parent/child relationship (e.g. component next to hub file)
    if (dir && aDir && (dir.startsWith(aDir + "/") || aDir.startsWith(dir + "/"))) {
      return true;
    }
  }
  return false;
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

  // Git-native envelope: working tree already updated via write/edit tools.
  // Prefer this over inventing search/replace when collaborating via git.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    const gitObj =
      o.git && typeof o.git === "object" && !Array.isArray(o.git)
        ? (o.git as Record<string, unknown>)
        : null;
    if (
      o.workingTree === true
      || o.git === true
      || gitObj != null
      || o.mode === "git"
      || o.mode === "workingTree"
    ) {
      const filesRaw = gitObj?.files ?? o.files ?? o.filesTouched;
      const filesTouched = Array.isArray(filesRaw)
        ? filesRaw.map(String).map(normalizeRepoPath).filter(Boolean)
        : [];
      const gitMessage = String(
        gitObj?.message ?? o.message ?? o.summary ?? "worker working-tree changes",
      ).slice(0, 500);
      const skip =
        typeof o.skip === "string" && o.skip.trim()
          ? o.skip.trim().slice(0, 500)
          : undefined;
      return {
        ok: true,
        hunks: [],
        skip,
        workingTree: true,
        gitMessage,
        filesTouched,
      };
    }
  }

  // Try strict parse first; if it fails, attempt per-hunk extraction so one
  // bad hunk doesn't kill the whole response.
  const v = WorkerResponseSchema.safeParse(parsed);
  if (v.success) {
    const allowed = allowedFileSet(expectedFiles);
    const allowAll = allowed.size === 0;
    const rejected: string[] = [];
    for (const h of v.data.hunks) {
      if (!fileAllowed(h.file, allowed, allowAll)) {
        rejected.push(h.file);
      }
    }
    if (rejected.length > 0) {
      return {
        ok: false,
        reason:
          `hunk file(s) not in expectedFiles: ${rejected.map((f) => JSON.stringify(f)).join(", ")} ` +
          `(allowed: ${expectedFiles.map(normalizeRepoPath).join(", ") || "(none)"})`,
      };
    }
    // Normalize paths on accepted hunks for apply consistency.
    const hunks = v.data.hunks.map((h) => ({
      ...h,
      file: normalizeRepoPath(h.file),
    })) as Hunk[];
    return { ok: true, hunks, skip: v.data.skip };
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

  const allowed = allowedFileSet(expectedFiles);
  const allowAll = allowed.size === 0;
  const validHunks: Hunk[] = [];
  const dropped: string[] = [];
  for (const h of softCap(rawHunks, MAX_HUNKS)) {
    const hv = HunkSchema.safeParse(h);
    if (!hv.success) continue;
    if (!fileAllowed(hv.data.file, allowed, allowAll)) {
      dropped.push(hv.data.file);
      continue;
    }
    validHunks.push({ ...hv.data, file: normalizeRepoPath(hv.data.file) } as Hunk);
  }

  const skip = typeof envelope.skip === "string" && envelope.skip.trim().length > 0
    ? envelope.skip.trim().slice(0, 500)
    : undefined;

  if (validHunks.length === 0 && !skip) {
    if (dropped.length > 0) {
      return {
        ok: false,
        reason:
          `hunk file(s) not in expectedFiles: ${dropped.map((f) => JSON.stringify(f)).join(", ")} ` +
          `(allowed: ${expectedFiles.map(normalizeRepoPath).join(", ") || "(none)"})`,
      };
    }
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

/**
 * Worker system prompt — lean.
 * Treat USER DIRECTIVE + TODO as a human work brief; implement with tools/git;
 * auditor approves the commit. Avoid overloaded micro-spec that causes give-up.
 */
export const WORKER_SYSTEM_PROMPT = [
  "You are a coding agent doing one work item from the board.",
  "",
  "How to work:",
  "- Read the USER DIRECTIVE (if any) and the TODO as your job brief — use your judgment.",
  "- Inspect with read/grep/glob/list; change files with write/edit; check with git_status/git_diff.",
  "- Prefer real disk changes over inventing large search/replace payloads.",
  "- Skip only if you verified the work is already done or truly impossible.",
  "",
  "Finish (required): after tools, respond with valid JSON only — no prose, no markdown fences:",
  '  Preferred: {"workingTree":true,"message":"short commit subject","files":["path/to/file.ts"]}',
  '  Small patches only: {"hunks":[{"op":"replace","file":"...","search":"...","replace":"..."}]}',
  '  Or: {"hunks":[],"skip":"reason"}',
  "  Max " + String(MAX_HUNKS) + " hunks if using hunks. search must match exactly once when used.",
  "  Hunk ops: replace | replace_between | write | create | append | delete.",
  "",
  ...hostToolingConstraintLines(),
  "Large/windowed files: use write/edit or replace_between/write — do not invent a search that spans omitted middle.",
  "",
  "Examples:",
  '{"workingTree":true,"message":"fix clamp boundary","files":["src/utils.js"]}',
  '{"hunks":[{"op":"replace","file":"src/utils.js","search":"function clamp(n, max) {\\n  return n > max ? max : n;\\n}","replace":"function clamp(n, max) {\\n  return n >= max ? max : n;\\n}"}]}',
  '{"hunks":[{"op":"create","file":"src/log.js","content":"export function log(msg) {\\n  console.log(`[app] ${msg}`);\\n}\\n"}]}',
  '{"hunks":[{"op":"append","file":"src/log.js","content":"export function warn(msg) {\\n  console.warn(msg);\\n}\\n"}]}',
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
  /**
   * Compact disk tab inventory for multi-tab HTML (full-file extract).
   * Prevents false "already contains N tabs" skips when windowed views hide the bar.
   */
  tabInventoryBlock?: string;
  /**
   * RR-B: prior apply miss from this run (todo.lastApplyMiss).
   * Prefer uniqueCandidates as search/start on re-emit.
   */
  lastApplyMiss?: {
    file: string;
    kind: string;
    op: string;
    needle: string;
    matchCount: number;
    message: string;
    uniqueCandidates: string[];
    nearbyExcerpt?: string;
    at?: number;
  };
}

/** Drop lastApplyMiss older than this (ms) so stale replan seeds don't poison. */
export const LAST_APPLY_MISS_TTL_MS = 45 * 60_000;

/** Format lastApplyMiss for worker first-pass seed (RR-B). */
export function buildLastApplyMissBlock(
  miss:
    | (NonNullable<WorkerSeed["lastApplyMiss"]> & { at?: number })
    | undefined
    | null,
  opts?: { expectedFiles?: readonly string[]; now?: number },
): string {
  if (!miss) return "";
  const now = opts?.now ?? Date.now();
  if (typeof miss.at === "number" && now - miss.at > LAST_APPLY_MISS_TTL_MS) {
    return "";
  }
  if (
    opts?.expectedFiles &&
    opts.expectedFiles.length > 0 &&
    !opts.expectedFiles.includes(miss.file)
  ) {
    return "";
  }
  const lines = [
    "=== PRIOR APPLY MISS (same todo / this run) ===",
    `kind=${miss.kind} file=${miss.file} op=${miss.op} matchCount=${miss.matchCount}`,
    `message: ${miss.message}`,
    `needle: ${JSON.stringify(miss.needle).slice(0, 200)}`,
  ];
  if (miss.uniqueCandidates.length > 0) {
    lines.push("Prefer these exact search/start strings (uniqueCandidates):");
    for (let i = 0; i < Math.min(5, miss.uniqueCandidates.length); i++) {
      lines.push(`  [${i}] ${JSON.stringify(miss.uniqueCandidates[i]).slice(0, 300)}`);
    }
  }
  if (miss.nearbyExcerpt?.trim()) {
    lines.push("nearbyExcerpt:");
    lines.push("---");
    lines.push(miss.nearbyExcerpt.split("\n").slice(0, 30).join("\n"));
    lines.push("---");
  }
  lines.push("Re-emit hunks with grounded anchors — do not invent needles.");
  lines.push("=== end prior apply miss ===");
  return lines.join("\n");
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
    /\b(literature\s+review|literature\s+research|web\s+research|web\s+search|desk\s+research)\b/i.test(
      d,
    )
  ) {
    return true;
  }
  // Find / look up / gather papers or sources (mid-string ok)
  if (
    /\b(find|look\s+up|gather|collect|cite)\s+(papers?|literature|sources?|citations?)\b/i.test(
      d,
    )
  ) {
    return true;
  }
  if (/\b(do\s+a\s+literature\s+review|systematic\s+review)\b/i.test(d)) {
    return true;
  }
  // arxiv / citations only with a research verb nearby (avoid bare "citation" noise)
  if (
    /\b(research|survey|review|read|fetch|search)\b.{0,40}\b(arxiv|citations?|bibliography)\b/i.test(
      d,
    ) ||
    /\b(arxiv|citations?|bibliography)\b.{0,40}\b(research|survey|review|papers?)\b/i.test(d)
  ) {
    return true;
  }
  if (/\b(survey papers?)\b/i.test(d)) return true;
  // "research X" / "research and document" as a primary verb phrase near the start
  if (/^(research|survey|investigate)\b/i.test(d)) return true;
  if (/\b(research (the |and |official |API |endpoints?|sources?))\b/i.test(d)) return true;
  // RR-C PR5: additive high-precision recall (keep panel anti-regressions green).
  // Do not reintroduce bare source|paper matches.
  if (/\bpeer[- ]reviewed\b/i.test(d)) return true;
  if (/\bdoi:\s*10\.\d/i.test(d)) return true;
  // Standalone arxiv token (product names like ResearchDashboard stay false above).
  if (/\barxiv\b/i.test(d)) return true;
  if (/\bcite\s+(papers?|sources?|literature)\b/i.test(d)) return true;
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
  // Directive-first: human prompt is primary; board TODO is a soft focus.
  const directiveLines = buildBlackboardDirectiveBlock(seed.directive, {
    labelSuffix:
      "(PRIMARY JOB BRIEF — treat like a human user prompt. Use your judgment. No mock/placeholder data.)",
    authoritative: true,
    includeAuthoritativeFraming: false,
  });
  if (directiveLines.length > 0) {
    parts.push("");
    parts.push(...directiveLines);
    parts.push("");
  }
  if (seed.userChatBlock && seed.userChatBlock.trim().length > 0) {
    parts.push(seed.userChatBlock.trim());
    parts.push("");
  }
  parts.push("## Work item (from board — soft focus, not a rigid recipe)");
  parts.push(seed.description);
  if (seed.expectedFiles.length > 0) {
    parts.push("");
    parts.push(
      `Suggested files (prefer these; same directory/basename OK): ${seed.expectedFiles.join(", ")}`,
    );
  }
  if (anchors.length > 0) {
    parts.push(`Optional anchors: ${anchors.map((a) => JSON.stringify(a)).join(", ")}`);
  }
  if (seed.tabInventoryBlock && seed.tabInventoryBlock.trim().length > 0) {
    parts.push("");
    parts.push(seed.tabInventoryBlock.trim());
  }
  parts.push("");
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
        "If this work needs sources: web_search/web_fetch, then document findings with URLs in the files you change.",
      );
      parts.push("");
    }
  }
  const missBlock = buildLastApplyMissBlock(seed.lastApplyMiss, {
    expectedFiles: seed.expectedFiles,
  });
  if (missBlock) {
    parts.push(missBlock);
    parts.push("");
  }
  parts.push(buildResearchNotesBlock(seed.researchNotes));
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
        .map((r) => {
          if (r.found === null) return `${JSON.stringify(r.anchor)}=MISS`;
          if (r.matchCount > 1) {
            const lines =
              r.matchLines?.join(",") ?? String(r.found);
            return `${JSON.stringify(r.anchor)}=MULTI×${r.matchCount}@${lines}`;
          }
          return `${JSON.stringify(r.anchor)}=line ${r.found}`;
        })
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

/**
 * Brief re-emit after empty / pure-think primary turns (1963ce25).
 * Does not re-paste full windowed files — only the job brief + optional tab inventory.
 */
export function buildWorkerEmptyReemitPrompt(
  todo: { description: string; expectedFiles: readonly string[] },
  parseError: string,
  opts?: { tabInventoryBlock?: string },
): string {
  const lines = [
    "Your previous turn produced no usable JSON envelope" +
      (parseError ? ` (${parseError.slice(0, 120)})` : "") +
      ".",
    "Emit JSON only now — no tools, no prose, no <think> dump.",
    "",
    `TODO: ${todo.description.slice(0, 500)}`,
  ];
  if (todo.expectedFiles.length > 0) {
    lines.push(`Files: ${todo.expectedFiles.join(", ")}`);
  }
  if (opts?.tabInventoryBlock?.trim()) {
    lines.push("");
    lines.push(opts.tabInventoryBlock.trim());
    lines.push(
      "If every requested topic is already listed above, emit " +
        '{"hunks":[],"skip":"already on disk per tab inventory"}.',
    );
    lines.push("If any requested topic is missing, you must ADD it (do not skip).");
  }
  lines.push("");
  lines.push("Valid finishes:");
  lines.push(
    '  {"workingTree":true,"message":"short subject","files":["path"]}',
  );
  lines.push('  {"hunks":[{"op":"replace","file":"...","search":"...","replace":"..."}]}');
  lines.push('  {"hunks":[],"skip":"reason"}');
  lines.push("JSON only.");
  return lines.join("\n");
}

// Task #78 (2026-04-25): self-repair when applyHunks fails because a
// `search` text doesn't exactly match the file (whitespace drift, tab
// vs spaces, CRLF vs LF, the model imagined a slightly-different
// version of the file). Prior behavior: markStale → replan from
// scratch with a fresh worker. Now: feed the actual file content +
// the failed hunks back to the SAME worker once before giving up.
//
// PR3 (eee6718f): grounded repair — optional ApplyMissReport supplies
// failed op/needle, nearbyExcerpt from disk, and uniqueCandidates so
// the model re-anchors on real substrings instead of inventing text.
// Cap at HUNK_REPAIR_FILE_SLICE chars — most worker turns are
// surgical and the worker doesn't need the whole 50KB file to fix
// one hunk. If the file is larger we send head+tail.
const HUNK_REPAIR_FILE_SLICE = 8_000;
const HUNK_REPAIR_FALLBACK_EXCERPT = 1_200;

export function buildHunkRepairPrompt(
  failedHunks: unknown[],
  applyError: string,
  fileContents: Record<string, string>,
  opts?: { miss?: ApplyMissReport },
): string {
  const miss = opts?.miss;
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

  const missLines: string[] = [];
  if (miss) {
    missLines.push(
      "Structured apply miss:",
      `  kind: ${miss.kind}`,
      `  file: ${miss.file}`,
      `  op: ${miss.op}`,
      `  hunkIndex: ${miss.hunkIndex}`,
      `  matchCount: ${miss.matchCount}`,
      `  needle (failed search/start): ${JSON.stringify(miss.needle)}`,
    );
    if (miss.nearbyExcerpt && miss.nearbyExcerpt.trim().length > 0) {
      missLines.push(
        "",
        "Nearby file excerpt (from disk at apply time — prefer re-anchoring here):",
        "--- BEGIN NEARBY EXCERPT ---",
        miss.nearbyExcerpt,
        "--- END NEARBY EXCERPT ---",
      );
    }
    if (miss.uniqueCandidates.length > 0) {
      missLines.push(
        "",
        "Suggested unique search/start strings (exact paste from the file — prefer these if they fit the edit):",
      );
      for (let i = 0; i < miss.uniqueCandidates.length; i++) {
        missLines.push(
          `--- CANDIDATE ${i + 1} ---`,
          miss.uniqueCandidates[i]!,
          `--- END CANDIDATE ${i + 1} ---`,
        );
      }
    }
    missLines.push("");
  } else {
    // No structured miss: still give a short head excerpt per file for grounding.
    for (const [file, contents] of Object.entries(fileContents)) {
      const excerpt =
        contents.length > HUNK_REPAIR_FALLBACK_EXCERPT
          ? contents.slice(0, HUNK_REPAIR_FALLBACK_EXCERPT) + "…"
          : contents;
      missLines.push(
        `Nearby excerpt (${file}):`,
        "--- BEGIN NEARBY EXCERPT ---",
        excerpt,
        "--- END NEARBY EXCERPT ---",
        "",
      );
    }
  }

  return [
    "Your previous diff did NOT apply to the file. The most common cause is a whitespace or newline mismatch — your `search`/`start` text doesn't exactly match what's actually in the file, or it is not unique.",
    `applyHunks error: ${applyError}`,
    "",
    ...missLines,
    "Rules for this repair:",
    "- Re-read the anchors against the ACTUAL file content below (and the nearby excerpt / candidates above).",
    "- Do NOT invent text that is not in the file. `search` / `start` must be a verbatim substring of the current file.",
    "- If unique candidates are listed, prefer pasting one of them as `search` or `start` when it matches the intended edit region.",
    "- Match exact whitespace, tabs vs spaces, and blank lines.",
    "- This is pure apply repair — do not research, browse the web, or change the intended edit; only fix anchors so the hunk applies.",
    "",
    "The ACTUAL current file content is below. Compare your search text to the real bytes.",
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

/** Miss kinds that should trigger grounded hunk repair (not replan/literature). */
export const REPAIRABLE_APPLY_MISS_KINDS: ReadonlySet<string> = new Set([
  "search_not_found",
  "search_not_unique",
  "start_not_found",
  "start_not_unique",
  "end_not_found", // RR-B: replace_between endExclusive misses are repairable
]);

/**
 * Whether an apply failure is a repairable anchor miss (search/start/end not
 * found or not unique). Prefer structured miss.kind; fall back to reason text.
 */
export function isRepairableApplyMiss(input: {
  miss?: ApplyMissReport;
  reason?: string;
}): boolean {
  if (input.miss && REPAIRABLE_APPLY_MISS_KINDS.has(input.miss.kind)) {
    return true;
  }
  const reason = input.reason ?? input.miss?.message ?? "";
  if (!reason) return false;
  if (/\b(search|start|endExclusive|end)\b/i.test(reason) && /not found/i.test(reason)) {
    return true;
  }
  if (/must be unique|matches \d+ times|not[_ ]unique/i.test(reason)) return true;
  return false;
}
