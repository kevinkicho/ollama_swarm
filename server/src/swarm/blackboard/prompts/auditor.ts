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
  "TOOLS (Unit 37): You have `read`, `grep`, `glob`, `list` on the cloned repo. USE THEM when the direct file-state evidence (shown in the user prompt) is ambiguous. Examples: if a criterion says 'tests cover the auth module' and you see one test file, grep for other test files referencing auth that might live elsewhere; if a criterion says 'README documents the CLI' and you see a README section, read the actual CLI entrypoint to verify the documentation matches the code. A 'met' verdict grounded in code-you-read is much stronger than one inferred from file existence alone.",
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
  "  4. If the requirement is genuinely absent, verdict is \"unmet\" with 1–4 concrete todos describing what to add. Workers CAN create new files from nothing — \"the file does not exist yet\" is NOT a reason to verdict `wont-do`. Emit a todo that creates the file.",
  "  5. `wont-do` is RESERVED and requires BOTH: (a) the criterion inherently needs shell execution that workers cannot perform (see Rule 8), OR at least one prior todo with status `committed`/`skipped` attempted this criterion, AND (b) further file edits are unlikely to help. If NEITHER holds — i.e., the work simply has not been attempted yet — verdict is \"unmet\" per step 4, even if no current file shows the requirement. Let the next audit judge the result of those new todos rather than giving up now.",
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
  "7. A criterion with ZERO attempted todos (no `committed`, no `skipped`) is NEVER `wont-do` unless Rule 8 applies. First-invocation hesitance is the problem this rule exists to prevent: if you have never asked workers to try, you have no evidence they cannot. Only after 1+ attempts have genuinely failed may you consider `wont-do` for non-execution criteria, and even then prefer a repair-focused `unmet` todo if any route to the requirement remains plausible.",
  "8. Workers edit files via JSON diffs — they CANNOT run shell commands, tests, linters, type checkers, compilers, formatters, package managers, or any external tooling. If a criterion inherently requires execution (e.g. \"all tests pass\", \"tsc compiles clean\", \"ESLint passes\", \"run benchmark X\"), issue `wont-do` with a rationale naming the tool that would be needed. Do NOT issue `unmet` with todos that merely touch config files in the hope of verifying the tool indirectly — those todos will produce empty `expectedFiles` and be rejected.",
  "9. `expectedFiles` entries are FILE paths, never directories. Do NOT emit `src/`, `__tests__/`, `docs/`, or any path ending in `/` or `\\`. If a todo or new criterion covers a whole directory, pick the specific files (e.g., `src/lib/a.ts`, `src/lib/b.ts`). Directory entries are rejected by the parser; the todo or criterion is dropped.",
  "10. If the current file state is WINDOWED (head + marker + tail), the middle region may contain evidence you can't see. Weight the visible head and tail heavily and prefer a specific consolidation/verification todo over a confident \"met\" when ambiguous.",
  "11. Unit 36: when the user prompt includes a `Live UI snapshot` block, that is PRIMARY EVIDENCE for any criterion framed as user-visible (\"renders\", \"displays\", \"button works\", \"page shows\", \"form submits\"). The snapshot is the accessibility tree of the actually-running app — if a criterion says \"home page shows a sign-up CTA\" and the snapshot shows no such element, the verdict is `unmet`, even if files were committed that ostensibly added it. Files are the SECONDARY evidence when a UI snapshot is present; they verify intent, the snapshot verifies delivery. When no UI snapshot is present, fall back to file-only evaluation (pre-Unit-36 behavior).",
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
 *   1. Criterion has its own expectedFiles → union them with the expectedFiles
 *      of committed todos whose criterionId === criterion.id (declared paths
 *      first, linked paths after; overall capped at
 *      `declared.length + AUDITOR_FALLBACK_FILE_MAX`). Unit 28 extended this
 *      from "return declared verbatim" to "union" so a planner guess that
 *      doesn't match where work actually landed doesn't starve the audit of
 *      real evidence.
 *   2. Otherwise (no declared files), union the expectedFiles of committed
 *      todos whose criterionId === criterion.id, newest first, capped at
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
  const byRecencyDesc = (a: CommittedTodoSummary, b: CommittedTodoSummary) =>
    (b.committedAt ?? 0) - (a.committedAt ?? 0);

  const linked = committed
    .filter((t) => t.criterionId === criterion.id)
    .slice()
    .sort(byRecencyDesc);
  const linkedFiles = dedupeCapped(
    linked.flatMap((t) => t.expectedFiles),
    AUDITOR_FALLBACK_FILE_MAX,
  );

  // Unit 28: when the criterion has declared expectedFiles, union them with
  // linked-committed-todo files rather than returning declared files alone.
  // Motivating case: 2026-04-21 multi-agent-orchestrator run — criterion c1
  // declared `src/brain/team-manager.test.ts` (parent `src/brain/` was in
  // the repo so the path passed Unit 6b grounding, but the file itself
  // never existed), while linked committed todos actually landed work at
  // `src/tests/team-manager.test.ts`. Under the pre-Unit-28 logic, the
  // auditor read only the dangling declared path, saw "file doesn't
  // exist", and called the criterion unmet — despite real work. Declared
  // files stay at the head of the list so they remain the primary
  // evidence; linked files come after as corroboration.
  if (criterion.expectedFiles.length > 0) {
    return dedupeCapped(
      [...criterion.expectedFiles, ...linkedFiles],
      criterion.expectedFiles.length + AUDITOR_FALLBACK_FILE_MAX,
    );
  }

  if (linkedFiles.length > 0) {
    return linkedFiles;
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
  // Unit 36: Playwright MCP snapshot of the running app's UI, when the
  // user supplied `cfg.uiUrl` AND MCP_PLAYWRIGHT_ENABLED=true. Captured
  // by a side-spawned `swarm-ui` agent right before the auditor prompt.
  // `uiUrl` echoes the url the snapshot is of; `uiSnapshot` is the raw
  // accessibility tree + text the MCP server returned (or an error
  // string on failure). Both undefined when UI verification is off.
  uiUrl?: string;
  uiSnapshot?: string;
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
  // Unit 36: optional UI snapshot + url passthrough. When provided, the
  // seed carries them into the user-prompt render so the auditor can
  // weight the snapshot as additional evidence.
  uiUrl?: string;
  uiSnapshot?: string;
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
    uiUrl: input.uiUrl,
    uiSnapshot: input.uiSnapshot,
  };
}

const MAX_CONTEXT_ITEMS = 40;

// Unit 46b: prompt-budget caps. The auditor prompt grows with cumulative
// state (rationales, files referenced by every unmet criterion); the
// post-Unit-41 run timed out three times in a row when the prompt got
// large enough that glm-5.1:cloud couldn't return headers in 5 minutes.
// These caps trade some auditor context completeness for predictable
// prompt size — a slightly less-informed verdict beats no verdict.
//
// AUDITOR_RATIONALE_MAX_CHARS: 400 — long enough for "criterion is met
// because file X line Y matches Z," short enough that 20 resolved
// criteria don't burn 50 KB on prose.
//
// AUDITOR_FILE_STATE_MAX_CHARS: 60_000 — sum of all file blocks in the
// "current file state" section. Above this, oldest entries (sorted
// alphabetically — chosen for stable test output) are dropped with a
// truncation marker. 60 KB is roughly 7-8 windowed files; if the
// auditor needs more, the contract has too many simultaneous open
// criteria and should be tier-gated anyway.
const AUDITOR_RATIONALE_MAX_CHARS = 400;
const AUDITOR_FILE_STATE_MAX_CHARS = 60_000;

function truncateRationale(s: string | undefined): string {
  if (!s) return "";
  const trimmed = s.trim();
  if (trimmed.length <= AUDITOR_RATIONALE_MAX_CHARS) return trimmed;
  return trimmed.slice(0, AUDITOR_RATIONALE_MAX_CHARS - 3) + "...";
}

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
    .map((c) => {
      const r = truncateRationale(c.rationale);
      return `- [${c.id}] (${c.status}) ${c.description}${r ? ` — ${r}` : ""}`;
    })
    .join("\n");
  const unmet = seed.unmetCriteria
    .map((c) => {
      const r = truncateRationale(c.rationale);
      return `- [${c.id}] ${c.description}${r ? ` — prior: ${r}` : ""} (expectedFiles: ${
        c.expectedFiles.length > 0 ? c.expectedFiles.join(", ") : "none"
      })`;
    })
    .join("\n");

  // File-state block: one entry per known file. Sorted for determinism so the
  // same seed always produces the same prompt (easier diffing in test output
  // and in the transcript log).
  // Unit 46b: total budget cap. We render entries in order; once the
  // running byte total would exceed the budget, drop remaining entries
  // and emit a truncation marker. Alphabetical order means the dropped
  // entries are always the last alphabetically — deterministic and
  // testable.
  const fileStateEntries = Object.entries(seed.currentFileState).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const fileStateBlocks: string[] = [];
  let fileStateUsed = 0;
  let fileStateDropped = 0;
  for (const [path, entry] of fileStateEntries) {
    let block: string;
    if (!entry.exists) {
      block = `--- ${path} (does not exist on disk) ---`;
    } else {
      const header = entry.full
        ? `--- ${path} (${entry.originalLength} chars, full) ---`
        : `--- ${path} (${entry.originalLength} chars, WINDOWED — head + marker + tail) ---`;
      block = `${header}\n${entry.content}\n--- end ${path} ---`;
    }
    // +2 for the "\n\n" separator between blocks (matches the .join below).
    if (fileStateUsed + block.length + 2 > AUDITOR_FILE_STATE_MAX_CHARS && fileStateBlocks.length > 0) {
      fileStateDropped = fileStateEntries.length - fileStateBlocks.length;
      break;
    }
    fileStateBlocks.push(block);
    fileStateUsed += block.length + 2;
  }
  if (fileStateDropped > 0) {
    fileStateBlocks.push(
      `--- [${fileStateDropped} additional file(s) omitted — total file-state would exceed ${AUDITOR_FILE_STATE_MAX_CHARS}-char budget. Verdict on those criteria using the committed/skipped lists below as evidence.] ---`,
    );
  }
  const fileStateBlock = fileStateBlocks.join("\n\n");

  // Unit 36: UI snapshot block, rendered only when a snapshot was
  // captured at audit time. Capped at ~16 KB to keep the prompt
  // bounded — browser_snapshot trees on complex pages can be massive.
  const UI_SNAPSHOT_MAX = 16_000;
  let uiSnapshotBlock: string[] = [];
  if (seed.uiUrl && seed.uiSnapshot) {
    const snap = seed.uiSnapshot.length > UI_SNAPSHOT_MAX
      ? seed.uiSnapshot.slice(0, UI_SNAPSHOT_MAX) +
        `\n\n… [${seed.uiSnapshot.length - UI_SNAPSHOT_MAX} chars truncated]`
      : seed.uiSnapshot;
    uiSnapshotBlock = [
      `=== Live UI snapshot (from ${seed.uiUrl}) — PRIMARY EVIDENCE for user-visible criteria ===`,
      snap,
      "=== end UI snapshot ===",
      "",
    ];
  }

  return [
    `Mission: ${seed.missionStatement}`,
    `Audit invocation: ${seed.auditInvocation} of ${seed.maxInvocations} (hard cap).`,
    "",
    "=== Criteria that still need a verdict (UNMET) ===",
    unmet.length > 0 ? unmet : "(none — all criteria already resolved)",
    "",
    ...uiSnapshotBlock,
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
