import { z } from "zod";
import type { ExitContract, ExitCriterion, Finding, Todo } from "../types.js";
import { windowFileForWorker } from "../windowFile.js";
import { parseJsonEnvelope } from "@ollama-swarm/shared/parseAgentJson";
import { lenientPreprocess, softCap } from "./lenientParse.js";
import { getModelBudget } from "../../modelContextBudget.js";
import { JSON_ONLY_FINAL_RULE_LINES, TOOL_CONTEST_HIERARCHY_NOTE } from "./sharedSnippets.js";

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

// Build-style todos (#237 parity with planner/replanner). Hunks default;
// kind:"build" requires a non-empty command the runner will post through.
const AuditorTodoSchemaHunks = z.object({
  kind: z.literal("hunks").optional(),
  description: z.string().trim().min(1).max(500),
  expectedFiles: z.array(filePathEntry).min(1).max(2),
  command: z.undefined().optional(),
});
const AuditorTodoSchemaBuild = z.object({
  kind: z.literal("build"),
  description: z.string().trim().min(1).max(500),
  expectedFiles: z.array(filePathEntry).min(1).max(2),
  command: z.string().trim().min(1).max(500),
});
const AuditorTodoSchema = z.union([AuditorTodoSchemaHunks, AuditorTodoSchemaBuild]);

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

export const AuditorResponseSchema = z.object({
  verdicts: z.array(AuditorVerdictSchema).max(20),
  newCriteria: z.array(AuditorNewCriterionSchema).max(8).optional(),
});

export interface AuditorTodo {
  description: string;
  expectedFiles: string[];
  /** "hunks" (default) or "build" — build requires `command`. */
  kind?: "hunks" | "build";
  /** Shell command for kind:"build" todos (runner enforce via build worker). */
  command?: string;
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


export function parseAuditorResponse(raw: string): AuditorParseResult {
  if (raw.trim().length === 0) {
    return { ok: false, reason: "empty response — model produced no output after stripping thinking tags" };
  }
  const envelopeResult = parseJsonEnvelope(raw);
  if (!envelopeResult.ok) {
    return { ok: false, reason: envelopeResult.reason };
  }
  const parsed = envelopeResult.value;

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
    // Preprocess nested todos (description/command/expectedFiles) before Zod.
    let itemForParse: unknown = item;
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      if (Array.isArray(rec.todos)) {
        itemForParse = {
          ...rec,
          todos: rec.todos.map((t) =>
            lenientPreprocess(t, {
              maxDescription: 500,
              maxExpectedFiles: 2,
              maxCommand: 500,
            }),
          ),
        };
      }
    }
    const itemProcessed = lenientPreprocess(itemForParse, {
      maxDescription: 500,
      maxExpectedFiles: 2,
      maxRationale: 800,
      maxCommand: 500,
    });
    const v = AuditorVerdictSchema.safeParse(itemProcessed);
    if (v.success) {
      verdicts.push({
        id: v.data.id,
        status: v.data.status,
        rationale: v.data.rationale,
        todos: (v.data.todos ?? []).map((t) => {
          const base: AuditorTodo = {
            description: t.description,
            expectedFiles: [...t.expectedFiles],
          };
          if (t.kind === "build" && typeof t.command === "string") {
            base.kind = "build";
            base.command = t.command;
          } else if (t.kind === "hunks") {
            base.kind = "hunks";
          }
          return base;
        }),
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
      const itemProcessed = lenientPreprocess(item, {
        maxDescription: 400,
        maxExpectedFiles: 4,
      });
      const v = AuditorNewCriterionSchema.safeParse(itemProcessed);
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

  const cappedVerdicts = softCap(verdicts, 20);
  const cappedNewCriteria = softCap(newCriteria, 8);

  const cap = AuditorResponseSchema.safeParse({
    verdicts: cappedVerdicts,
    newCriteria: cappedNewCriteria.length > 0 ? cappedNewCriteria : undefined,
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
  "You are the AUDITOR. After workers drain, judge whether the EXIT CONTRACT is met.",
  "",
  "TOOLS: read, grep, glob, list — use when file-state evidence is ambiguous.",
  "User prompt provides mission, UNMET criteria, CURRENT CONTENTS of expectedFiles (full or windowed), commits/skips/findings.",
  TOOL_CONTEST_HIERARCHY_NOTE,
  "",
  "Per UNMET criterion (file state is primary evidence):",
  "  - satisfied in files → \"met\" (quote a short phrase in rationale).",
  "  - duplicates/stacking/half-done → \"unmet\" with CONSOLIDATE/REPAIR todos, not re-add.",
  "  - genuinely absent → \"unmet\" with 1–4 todos. Workers CAN create new files; missing file ≠ wont-do.",
  "  - wont-do only if outside WORKER CAPABILITIES (rule 8) OR after prior committed/skipped attempts with no plausible file path left.",
  "Optional newCriteria for outcomes the contract missed (no todos yet).",
  "",
  "RULES:",
  "1. Final response:",
  ...JSON_ONLY_FINAL_RULE_LINES.map((line) => `   ${line}`),
  "2. Shape: {\"verdicts\":[{\"id\",\"status\":\"met\"|\"wont-do\"|\"unmet\",\"rationale\",\"todos\"?:[{\"description\",\"expectedFiles\",\"kind\"?:\"hunks\"|\"build\",\"command\"?:string}]}],\"newCriteria\"?:[{\"description\",\"expectedFiles\"}]}.",
  "3. Verdict ids only for currently unmet criteria (c1, c2, …). Do not re-verdict already met or wont-do.",
  "4. For unmet, todos REQUIRED (1–4), each ≤2 expectedFiles (FILE paths, not directories).",
  "5. Rationale: one sentence, grounded in file state when possible.",
  "6. Zero attempted todos → never wont-do unless rule 8 applies; prefer unmet + try first.",
  "7. WORKER CAPABILITIES:",
  "   (a) Hunk workers: JSON file diffs only.",
  "   (b) kind:\"build\" + allowlisted command / build workers: project scripts — prefer unmet+build when a script is the right fix.",
  "   (c) Issue wont-do ONLY for needs outside hunks and build (human/cloud/hardware, etc.).",
  "8. WINDOWED files: prefer consolidate/verify todos over confident met on ambiguous middles.",
  "9. Live UI snapshot (if present) is primary for user-visible criteria; if snapshot contradicts claimed UI work, verdict is unmet. Files secondary. No snapshot → fall back to file-only evaluation.",
  "10. Worker skip \"already exists\": grep before overriding; confirm if grep matches.",
  "Paths: repo-relative, no `..`.",
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
  fullFileMode?: boolean,
): Record<string, AuditorFileStateEntry> {
  const out: Record<string, AuditorFileStateEntry> = {};
  for (const [path, content] of Object.entries(fileContents)) {
    if (content === null) {
      out[path] = { exists: false, content: "", full: true, originalLength: 0 };
      continue;
    }
    // In fullFileMode, show the entire file — no windowing.
    if (fullFileMode) {
      out[path] = { exists: true, content, full: true, originalLength: content.length };
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
  // Plan 8: show full file content for large-context models.
  fullFileMode?: boolean;
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
  const currentFileState = buildAuditorFileStates(fileContents, input.fullFileMode);

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

export function buildAuditorUserPrompt(seed: AuditorSeed, model?: string): string {
  const budget = getModelBudget(model);
  const maxContextItems = budget.fullFileMode ? 200 : 40;
  const fileStateMaxChars = budget.fullFileMode ? 500_000 : 60_000;
  const committed = seed.committed
    .slice(-maxContextItems)
    .map((c) => `- [${c.todoId}] ${c.description} (files: ${c.expectedFiles.join(", ") || "none"})`)
    .join("\n");
  const skipped = seed.skipped
    .slice(-maxContextItems)
    .map((s) => `- [${s.todoId}] ${s.description}${s.skippedReason ? ` — ${s.skippedReason}` : ""}`)
    .join("\n");
  const findings = seed.findings
    .slice(-maxContextItems)
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
    if (fileStateUsed + block.length + 2 > fileStateMaxChars && fileStateBlocks.length > 0) {
      fileStateDropped = fileStateEntries.length - fileStateBlocks.length;
      break;
    }
    fileStateBlocks.push(block);
    fileStateUsed += block.length + 2;
  }
  if (fileStateDropped > 0) {
    fileStateBlocks.push(
      `--- [${fileStateDropped} additional file(s) omitted — total file-state would exceed ${fileStateMaxChars}-char budget. Verdict on those criteria using the committed/skipped lists below as evidence.] ---`,
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
    "Shape reminder: {\"verdicts\": [{\"id\", \"status\", \"rationale\", \"todos\"?: [{\"description\", \"expectedFiles\", \"kind\"?: \"hunks\"|\"build\", \"command\"?: string}]}], \"newCriteria\"?: [...]}.",
    "For kind:\"build\" todos, `command` is REQUIRED (allowlisted project script).",
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
    '{"verdicts":[{"id":"c1","status":"met|wont-do|unmet","rationale":"...","todos":[{"description":"...","expectedFiles":["..."],"kind":"hunks|build","command":"...only when kind is build"}]}],"newCriteria":[{"description":"...","expectedFiles":["..."]}]}',
    "Todo fields: description + expectedFiles required. Optional kind (default hunks). When kind is \"build\", command is REQUIRED.",
    "",
    "No prose. No markdown fences. No commentary. Just the JSON object.",
  ].join("\n");
}
