import { z } from "zod";
import type { ExitContract, ExitCriterion, Finding, Todo } from "../types.js";
import { windowFileForWorker } from "../windowFile.js";

// ---------------------------------------------------------------------------
// Phase 11c: auditor.
//
// Called when the board drains (no open/claimed/stale todos, no pending
// replans). Takes the current contract + recent committed work and decides,
// per unmet criterion, whether it's now "met", "wont-do", or still "unmet"
// (in which case the auditor proposes fresh todos to satisfy it).
//
// Also allowed to add brand-new criteria it discovered during the run. Those
// start "unmet" with no todos — the next audit round (or planner pass) picks
// them up.
// ---------------------------------------------------------------------------

// File paths only — see planner.ts for the motivating incident. Same rule
// applies here because auditor todos and new criteria feed the same Board.
const filePathEntry = z
  .string()
  .trim()
  .min(1)
  .refine((p) => !p.endsWith("/") && !p.endsWith("\\"), {
    message: "must be a file path, not a directory (no trailing / or \\)",
  });

const AuditorTodoSchema = z.object({
  description: z.string().trim().min(1).max(500),
  expectedFiles: z.array(filePathEntry).min(1).max(2),
});

const VerdictStatusSchema = z.enum(["met", "wont-do", "unmet"]);

const AuditorVerdictSchema = z.object({
  id: z.string().trim().min(1).max(64),
  status: VerdictStatusSchema,
  rationale: z.string().trim().min(1).max(800),
  todos: z.array(AuditorTodoSchema).max(4).optional(),
});

const AuditorNewCriterionSchema = z.object({
  description: z.string().trim().min(1).max(400),
  expectedFiles: z.array(filePathEntry).min(0).max(4),
});

const AuditorResponseSchema = z.object({
  verdicts: z.array(AuditorVerdictSchema).max(20),
  newCriteria: z.array(AuditorNewCriterionSchema).max(8).optional(),
});

export interface AuditorTodo {
  description: string;
  expectedFiles: string[];
}

export interface AuditorVerdict {
  id: string;
  status: "met" | "wont-do" | "unmet";
  rationale: string;
  todos: AuditorTodo[];
}

export interface AuditorNewCriterion {
  description: string;
  expectedFiles: string[];
}

export interface AuditorResult {
  verdicts: AuditorVerdict[];
  newCriteria: AuditorNewCriterion[];
}

export interface AuditorDropped {
  reason: string;
  raw: unknown;
}

export type AuditorParseResult =
  | { ok: true; result: AuditorResult; dropped: AuditorDropped[] }
  | { ok: false; reason: string };

function stripFences(raw: string): string | null {
  const s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  const innerFence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (innerFence) return innerFence[1].trim();
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) {
    return s.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

export function parseAuditorResponse(raw: string): AuditorParseResult {
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

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `expected top-level JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    };
  }

  const envelope = parsed as Record<string, unknown>;
  if (!Array.isArray(envelope.verdicts)) {
    return { ok: false, reason: "verdicts must be an array" };
  }

  const verdicts: AuditorVerdict[] = [];
  const dropped: AuditorDropped[] = [];
  for (const item of envelope.verdicts) {
    const v = AuditorVerdictSchema.safeParse(item);
    if (v.success) {
      verdicts.push({
        id: v.data.id,
        status: v.data.status,
        rationale: v.data.rationale,
        todos: (v.data.todos ?? []).map((t) => ({
          description: t.description,
          expectedFiles: [...t.expectedFiles],
        })),
      });
    } else {
      const reason = v.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      dropped.push({ reason, raw: item });
    }
  }

  const newCriteria: AuditorNewCriterion[] = [];
  if (envelope.newCriteria !== undefined) {
    if (!Array.isArray(envelope.newCriteria)) {
      return { ok: false, reason: "newCriteria must be an array when present" };
    }
    for (const item of envelope.newCriteria) {
      const v = AuditorNewCriterionSchema.safeParse(item);
      if (v.success) {
        newCriteria.push({
          description: v.data.description,
          expectedFiles: [...v.data.expectedFiles],
        });
      } else {
        const reason = v.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        dropped.push({ reason, raw: item });
      }
    }
  }

  const cap = AuditorResponseSchema.safeParse({
    verdicts,
    newCriteria: newCriteria.length > 0 ? newCriteria : undefined,
  });
  if (!cap.success) {
    const reason = cap.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }

  return { ok: true, result: { verdicts, newCriteria }, dropped };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const AUDITOR_SYSTEM_PROMPT = [
  "You are the AUDITOR for a swarm of coding agents.",
  "You are called at a checkpoint: the worker pool has drained (no todos left in flight). Your job is to decide whether the EXIT CONTRACT is satisfied.",
  "",
  "The user prompt will give you:",
  "  - the mission statement,",
  "  - each UNMET criterion with its expectedFiles,",
  "  - the CURRENT CONTENTS of every file named by an unmet criterion's expectedFiles, shown either in full or — for files above ~8KB — as a head + marker + tail window (the marker tells you how many chars are omitted from the middle),",
  "  - recent committed/skipped todos and agent findings for context.",
  "",
  "DECISION PROCESS for each UNMET criterion:",
  "  1. Read the CURRENT FILE STATE for that criterion's expectedFiles. This is the primary evidence — commit history is secondary.",
  "  2. If the file already shows the requirement satisfied, verdict is \"met\". Quote a short phrase from the shown content in your rationale so the call is auditable.",
  "  3. If the file shows evidence of prior attempts that produced DUPLICATES (e.g. the same heading or table appearing twice), STACKING (new blocks pasted without removing the old), or HALF-DONE edits, the verdict is \"unmet\" and the todos MUST be CONSOLIDATE/REPAIR/DEDUP todos, not \"add X\" todos. A re-add todo in this situation will just produce another duplicate.",
  "  4. If the requirement is genuinely absent, verdict is \"unmet\" with 1–4 concrete todos describing what to add.",
  "  5. If the requirement needs shell execution or is out of scope, verdict is \"wont-do\" with a rationale.",
  "",
  "You MAY add new criteria via `newCriteria` when you discover important outcomes the initial contract missed. New criteria start with no todos — future audits can propose todos for them.",
  "",
  "HARD RULES:",
  "1. Output ONLY a single JSON object. No prose. No markdown fences. No commentary.",
  "2. Shape: {\"verdicts\": [{\"id\": string, \"status\": \"met\"|\"wont-do\"|\"unmet\", \"rationale\": string, \"todos\"?: [...]}], \"newCriteria\"?: [{\"description\": string, \"expectedFiles\": string[]}]}.",
  "3. Every verdict's `id` MUST match an existing unmet criterion ID (c1, c2, ...). Do NOT include verdicts for criteria that are already met or wont-do.",
  "4. For `unmet` status, `todos` is REQUIRED and must contain 1–4 items; each todo names ≤2 expectedFiles (repo-relative paths).",
  "5. Each verdict's `rationale` is one sentence explaining the call; when possible, reference what you saw in the current file state.",
  "6. Each `newCriteria` item's `description` is one outcome (not a step). `expectedFiles` is 0–4 repo-relative paths.",
  "7. Prefer `wont-do` with a clear rationale over infinite `unmet` loops. If prior todos for a criterion failed (stale/skipped) AND the file still doesn't show the requirement, consider whether the criterion is practical at all.",
  "8. Workers edit files via JSON diffs — they CANNOT run shell commands, tests, linters, type checkers, compilers, formatters, package managers, or any external tooling. If a criterion inherently requires execution (e.g. \"all tests pass\", \"tsc compiles clean\", \"ESLint passes\", \"run benchmark X\"), issue `wont-do` with a rationale naming the tool that would be needed. Do NOT issue `unmet` with todos that merely touch config files in the hope of verifying the tool indirectly — those todos will produce empty `expectedFiles` and be rejected.",
  "9. `expectedFiles` entries are FILE paths, never directories. Do NOT emit `src/`, `__tests__/`, `docs/`, or any path ending in `/` or `\\`. If a todo or new criterion covers a whole directory, pick the specific files (e.g., `src/lib/a.ts`, `src/lib/b.ts`). Directory entries are rejected by the parser; the todo or criterion is dropped.",
  "10. If the current file state is WINDOWED (head + marker + tail), the middle region may contain evidence you can't see. Weight the visible head and tail heavily and prefer a specific consolidation/verification todo over a confident \"met\" when ambiguous.",
  "",
  "Paths must be repo-relative. Never use absolute paths or `..`.",
].join("\n");

export interface CommittedTodoSummary {
  todoId: string;
  description: string;
  expectedFiles: string[];
  committedAt?: number;
  // Unit 5d: back-link from committed todo → criterion, so the auditor can
  // fall back to these files when a criterion has no expectedFiles of its own.
  // Optional because legacy todos (before Phase 11a) and discussion-only todos
  // never had one.
  criterionId?: string;
}

// Unit 5d: per-criterion cap on files included via fallback (not via
// criterion.expectedFiles). Keeps a criterion with no expectedFiles from
// dragging in an unbounded history's worth of paths.
export const AUDITOR_FALLBACK_FILE_MAX = 4;

// Unit 5d: when a criterion has neither its own expectedFiles nor any
// criterion-linked committed todos, widen to this many of the most recent
// unlinked committed todos. "Unlinked" because a todo with a different
// criterionId is already covered by that other criterion's resolution.
export const AUDITOR_FALLBACK_RECENT_COMMITS = 4;

/**
 * Decide which on-disk files the auditor should read for a given criterion.
 *
 *   1. Criterion has its own expectedFiles → return them verbatim (happy path).
 *   2. Otherwise, union the expectedFiles of committed todos whose
 *      criterionId === criterion.id, newest first, capped at
 *      AUDITOR_FALLBACK_FILE_MAX.
 *   3. Otherwise, union the expectedFiles of the most recent
 *      AUDITOR_FALLBACK_RECENT_COMMITS committed todos with NO criterionId
 *      — those are the likeliest candidates for an unwired criterion.
 *      Same cap applies.
 *
 * Pure function. Deterministic when `committed` is deterministically ordered.
 */
export function resolveCriterionFiles(
  criterion: ExitCriterion,
  committed: CommittedTodoSummary[],
): string[] {
  if (criterion.expectedFiles.length > 0) {
    return [...criterion.expectedFiles];
  }

  const byRecencyDesc = (a: CommittedTodoSummary, b: CommittedTodoSummary) =>
    (b.committedAt ?? 0) - (a.committedAt ?? 0);

  const linked = committed
    .filter((t) => t.criterionId === criterion.id)
    .slice()
    .sort(byRecencyDesc);
  if (linked.length > 0) {
    return dedupeCapped(linked.flatMap((t) => t.expectedFiles), AUDITOR_FALLBACK_FILE_MAX);
  }

  const recentOrphans = committed
    .filter((t) => !t.criterionId)
    .slice()
    .sort(byRecencyDesc)
    .slice(0, AUDITOR_FALLBACK_RECENT_COMMITS);
  return dedupeCapped(recentOrphans.flatMap((t) => t.expectedFiles), AUDITOR_FALLBACK_FILE_MAX);
}

function dedupeCapped(files: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

export interface SkippedTodoSummary {
  todoId: string;
  description: string;
  skippedReason?: string;
}

export interface FindingSummary {
  agentId: string;
  text: string;
  createdAt: number;
}

// Current state of a file the auditor cares about (i.e. named in some unmet
// criterion's expectedFiles). Shape is intentionally flat rather than a
// discriminated union on `exists` so prompt-building code can read fields
// without narrowing — the convention is: on !exists, content is "" and
// originalLength is 0, and `full` is true (there's nothing omitted).
export interface AuditorFileStateEntry {
  exists: boolean;
  content: string;
  full: boolean;
  originalLength: number;
}

// Build per-file state entries from a batch read. Reuses windowFileForWorker
// so the auditor sees the same head+marker+tail view the worker does — no
// need to teach two call sites about truncation math. Pure: I/O lives in the
// caller (typically BlackboardRunner.readExpectedFiles).
export function buildAuditorFileStates(
  fileContents: Record<string, string | null>,
): Record<string, AuditorFileStateEntry> {
  const out: Record<string, AuditorFileStateEntry> = {};
  for (const [path, content] of Object.entries(fileContents)) {
    if (content === null) {
      out[path] = { exists: false, content: "", full: true, originalLength: 0 };
      continue;
    }
    const view = windowFileForWorker(content);
    out[path] = {
      exists: true,
      content: view.content,
      full: view.full,
      originalLength: view.originalLength,
    };
  }
  return out;
}

export interface AuditorSeed {
  missionStatement: string;
  unmetCriteria: ExitCriterion[];
  resolvedCriteria: ExitCriterion[];
  committed: CommittedTodoSummary[];
  skipped: SkippedTodoSummary[];
  findings: FindingSummary[];
  // Current on-disk state of every file referenced by any unmet criterion's
  // expectedFiles. Unit 5a populates this but does NOT yet thread it into the
  // prompt — Unit 5b does that, so this field sits unread for one commit.
  currentFileState: Record<string, AuditorFileStateEntry>;
  auditInvocation: number;
  maxInvocations: number;
}

// ---------------------------------------------------------------------------
// Unit 5e: pure seed composition. Extracted from BlackboardRunner so the full
// wiring — contract → committed summaries → resolveCriterionFiles →
// readFiles → buildAuditorFileStates → seed — is testable without spinning up
// a runner. The runner method becomes a thin wrapper around this.
// ---------------------------------------------------------------------------

export interface BuildAuditorSeedInput {
  contract: ExitContract;
  todos: Todo[];
  findings: Finding[];
  readFiles: (paths: string[]) => Promise<Record<string, string | null>>;
  auditInvocation: number;
  maxInvocations: number;
}

export async function buildAuditorSeedCore(
  input: BuildAuditorSeedInput,
): Promise<AuditorSeed> {
  const { contract, todos, findings, readFiles, auditInvocation, maxInvocations } = input;

  const committed: CommittedTodoSummary[] = todos
    .filter((t) => t.status === "committed")
    .sort((a, b) => (a.committedAt ?? 0) - (b.committedAt ?? 0))
    .map((t) => ({
      todoId: t.id,
      description: t.description,
      expectedFiles: [...t.expectedFiles],
      committedAt: t.committedAt,
      criterionId: t.criterionId,
    }));

  const skipped: SkippedTodoSummary[] = todos
    .filter((t) => t.status === "skipped")
    .map((t) => ({
      todoId: t.id,
      description: t.description,
      skippedReason: t.skippedReason,
    }));

  const findingSummaries: FindingSummary[] = findings.map((f) => ({
    agentId: f.agentId,
    text: f.text,
    createdAt: f.createdAt,
  }));

  // Unit 5d: for unmet criteria whose planner-written expectedFiles is empty,
  // infer candidate files from committed todos linked to the same criterion
  // (or from recent unlinked commits as a weak fallback). The resolved list
  // replaces expectedFiles ONLY on the seed's unmet view — the underlying
  // contract is untouched.
  const unmetCriteria = contract.criteria
    .filter((c) => c.status === "unmet")
    .map((c) => ({ ...c, expectedFiles: resolveCriterionFiles(c, committed) }));

  const filesToRead = Array.from(
    new Set(unmetCriteria.flatMap((c) => c.expectedFiles)),
  );
  const fileContents = filesToRead.length > 0 ? await readFiles(filesToRead) : {};
  const currentFileState = buildAuditorFileStates(fileContents);

  return {
    missionStatement: contract.missionStatement,
    unmetCriteria,
    resolvedCriteria: contract.criteria
      .filter((c) => c.status !== "unmet")
      .map((c) => ({ ...c, expectedFiles: [...c.expectedFiles] })),
    committed,
    skipped,
    findings: findingSummaries,
    currentFileState,
    auditInvocation,
    maxInvocations,
  };
}

const MAX_CONTEXT_ITEMS = 40;

export function buildAuditorUserPrompt(seed: AuditorSeed): string {
  const committed = seed.committed
    .slice(-MAX_CONTEXT_ITEMS)
    .map((c) => `- [${c.todoId}] ${c.description} (files: ${c.expectedFiles.join(", ") || "none"})`)
    .join("\n");
  const skipped = seed.skipped
    .slice(-MAX_CONTEXT_ITEMS)
    .map((s) => `- [${s.todoId}] ${s.description}${s.skippedReason ? ` — ${s.skippedReason}` : ""}`)
    .join("\n");
  const findings = seed.findings
    .slice(-MAX_CONTEXT_ITEMS)
    .map((f) => `- [${f.agentId}] ${f.text}`)
    .join("\n");
  const resolved = seed.resolvedCriteria
    .map((c) => `- [${c.id}] (${c.status}) ${c.description}${c.rationale ? ` — ${c.rationale}` : ""}`)
    .join("\n");
  const unmet = seed.unmetCriteria
    .map(
      (c) =>
        `- [${c.id}] ${c.description} (expectedFiles: ${
          c.expectedFiles.length > 0 ? c.expectedFiles.join(", ") : "none"
        })`,
    )
    .join("\n");

  // File-state block: one entry per known file. Sorted for determinism so the
  // same seed always produces the same prompt (easier diffing in test output
  // and in the transcript log).
  const fileStateEntries = Object.entries(seed.currentFileState).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const fileStateBlock = fileStateEntries
    .map(([path, entry]) => {
      if (!entry.exists) {
        return `--- ${path} (does not exist on disk) ---`;
      }
      const header = entry.full
        ? `--- ${path} (${entry.originalLength} chars, full) ---`
        : `--- ${path} (${entry.originalLength} chars, WINDOWED — head + marker + tail) ---`;
      return `${header}\n${entry.content}\n--- end ${path} ---`;
    })
    .join("\n\n");

  return [
    `Mission: ${seed.missionStatement}`,
    `Audit invocation: ${seed.auditInvocation} of ${seed.maxInvocations} (hard cap).`,
    "",
    "=== Criteria that still need a verdict (UNMET) ===",
    unmet.length > 0 ? unmet : "(none — all criteria already resolved)",
    "",
    "=== Current file state for UNMET criteria (primary evidence) ===",
    fileStateEntries.length > 0
      ? fileStateBlock
      : "(no files — unmet criteria have no expectedFiles)",
    "",
    "=== Criteria already resolved (for context only; do NOT re-verdict) ===",
    resolved.length > 0 ? resolved : "(none)",
    "",
    "=== Committed todos (most recent first, up to 40) ===",
    committed.length > 0 ? committed : "(nothing committed yet)",
    "",
    "=== Skipped todos (most recent first, up to 40) ===",
    skipped.length > 0 ? skipped : "(no skips)",
    "",
    "=== Agent findings (up to 40) ===",
    findings.length > 0 ? findings : "(no findings recorded)",
    "",
    "Respond now with ONLY the JSON envelope. No prose, no fences.",
    "Shape reminder: {\"verdicts\": [...], \"newCriteria\"?: [...]}.",
  ].join("\n");
}

export function buildAuditorRepairPrompt(previousResponse: string, parseError: string): string {
  return [
    "Your previous response could not be parsed as the required JSON envelope.",
    `Parser error: ${parseError}`,
    "",
    "Your previous response was:",
    "--- BEGIN PREVIOUS RESPONSE ---",
    previousResponse,
    "--- END PREVIOUS RESPONSE ---",
    "",
    "Respond now with ONLY a JSON object matching the schema:",
    '{"verdicts":[{"id":"c1","status":"met|wont-do|unmet","rationale":"...","todos":[{"description":"...","expectedFiles":["..."]}]}],"newCriteria":[{"description":"...","expectedFiles":["..."]}]}',
    "",
    "No prose. No markdown fences. No commentary. Just the JSON object.",
  ].join("\n");
}
