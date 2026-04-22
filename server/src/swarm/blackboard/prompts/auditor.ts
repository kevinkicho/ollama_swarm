import { z } from "zod";
import type { ExitCriterion } from "../types.js";
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
