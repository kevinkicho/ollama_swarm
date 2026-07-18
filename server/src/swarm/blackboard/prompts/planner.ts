import { z } from "zod";
import { parseJsonEnvelope } from "@ollama-swarm/shared/parseAgentJson";
import { lenientPreprocess, softCap } from "./lenientParse.js";
import { registerParserSchema } from "./brainIntegration.js";
import { getModelBudget } from "../../modelContextBudget.js";
import { buildPlannerGroundingBlocks } from "./plannerGrounding.js";
import { buildBlackboardDirectiveBlock } from "../../directivePromptHelpers.js";
import { JSON_ONLY_FINAL_RULE_LINES } from "./sharedSnippets.js";

// ---------------------------------------------------------------------------
// Schema: what we expect back from the planner. Kept tight on purpose — small
// atomic units (<=2 files, one short description) is the whole point of the
// blackboard preset. Anything that violates the shape gets dropped.
// ---------------------------------------------------------------------------

// File paths only — a directory entry (trailing / or \) trips a worker's hash
// pass with EISDIR and forces a stale→replan cycle. Reject at parse time so
// junk never reaches the Board. See docs/known-limitations.md (resolved) for
// the incident that motivated this.
const filePathEntry = z
  .string()
  .trim()
  .min(1)
  .refine((p) => !p.endsWith("/") && !p.endsWith("\\"), {
    message: "must be a file path, not a directory (no trailing / or \\)",
  });

// Unit 44b: anchor strings the planner expects to find in
// expectedFiles. Each entry is a verbatim substring (≤ 200 chars) the
// runner will search for; matched anchors get ±25 lines of context
// injected into the worker prompt seed. Capped at 4 to bound prompt
// size — most row-level edits need 1-2 anchors.
const ANCHOR_MAX_CHARS = 200;
const ANCHOR_MAX_PER_TODO = 4;
const anchorEntry = z.string().trim().min(1).max(ANCHOR_MAX_CHARS);

// Task #70 (2026-04-25): symbol names the planner expects to find
// in expectedFiles. The runner verifies each symbol exists with a
// word-boundary grep BEFORE posting the todo, so todos premised on
// classes/functions that don't exist (the planner's most common
// failure mode — see Pattern 12 in run patterns memory) get dropped
// before any worker prompt fires. Cap at 4 to bound prompt size +
// validation work.
const SYMBOL_MAX_CHARS = 200;
const SYMBOLS_MAX_PER_TODO = 4;
const symbolEntry = z.string().trim().min(1).max(SYMBOL_MAX_CHARS);

// Task #237 (2026-04-28): build-style TODO support. Two discriminants:
//   kind: "hunks" (default, omit for backwards-compat) — worker emits
//     a {hunks: [...]} JSON envelope, runner applies + commits.
//   kind: "build" — worker runs `command` via opencode's bash tool
//     (swarm-builder agent profile), runner commits whatever changed
//     in the working tree. Use for TODOs that REQUIRE script execution
//     (doc generators, codegen, formatters, type-checkers that emit
//     fix files). Command is gated by buildCommandAllowlist.
// 2026-05-02 (auto-rollback decision #1): explicit criterion attribution.
// Each todo declares which contract criterion ID(s) it serves. Required
// for per-criterion rollback (decision #2) — without this we'd have to
// infer attribution post-hoc from expectedFiles intersection, which is
// fragile when todos touch overlapping files. Capped at 5 because a
// single todo serving more than that is a red flag for over-broad scope.
const criterionIdEntry = z.string().trim().min(1).max(40);
const CRITERIA_PER_TODO_MAX = 5;

const PlannerTodoSchemaHunks = z.object({
  kind: z.literal("hunks").optional(),
  description: z.string().trim().min(1),
  expectedFiles: z.array(filePathEntry).min(1).max(2),
  expectedAnchors: z.array(anchorEntry).max(ANCHOR_MAX_PER_TODO).optional(),
  expectedSymbols: z.array(symbolEntry).max(SYMBOLS_MAX_PER_TODO).optional(),
  command: z.undefined().optional(),
  // Phase 5c of #243: optional planner hint to route this TODO to a
  // worker with a matching topology tag. Capped at 40 chars to mirror
  // the AgentSpec.tag schema. Runner enforces tag-routing preference;
  // schema just accepts the hint.
  preferredTag: z.string().trim().max(40).optional(),
  // 2026-05-02: criterion attribution. Optional — back-compat for
  // pre-tagged callers + analyses where the planner can't cleanly
  // attribute (e.g. exploratory cleanup todos).
  criteria: z.array(criterionIdEntry).max(CRITERIA_PER_TODO_MAX).optional(),
  // Plan 2: optional files the worker needs to READ for context but
  // NOT modify. Max 3 context files per TODO.
  contextFiles: z.array(filePathEntry).max(3).optional(),
});
const PlannerTodoSchemaBuild = z.object({
  kind: z.literal("build"),
  description: z.string().trim().min(1),
  // For build TODOs, expectedFiles describes files we EXPECT the command
  // to change (for the commit message + verification). At least one
  // path so the auditor has something to verify; cap stays at 2 to
  // discourage planner from proposing whole-tree builds.
  expectedFiles: z.array(filePathEntry).min(1).max(2),
  command: z.string().trim().min(1).max(500),
  expectedAnchors: z.array(anchorEntry).max(ANCHOR_MAX_PER_TODO).optional(),
  expectedSymbols: z.array(symbolEntry).max(SYMBOLS_MAX_PER_TODO).optional(),
  // Phase 5c of #243: same preferredTag hint for build TODOs (e.g.
  // a `bun run docs:api` TODO might prefer the `docs-expert` worker).
  preferredTag: z.string().trim().max(40).optional(),
  // 2026-05-02: criterion attribution (see hunks variant above).
  criteria: z.array(criterionIdEntry).max(CRITERIA_PER_TODO_MAX).optional(),
});
export const PlannerTodoSchema = z.union([PlannerTodoSchemaHunks, PlannerTodoSchemaBuild]);

// Task #71 (2026-04-25): lowered cap from 20 → 5. Earlier blackboard
// runs surfaced a "skip cascade" pattern — the planner posted up to 20
// todos based on assumed code structure ("Agent class constructor",
// "Brain class") and 16 of 20 got declined by workers because the
// referenced symbols didn't exist. Smaller batches let the planner
// see worker feedback (declines, repair-prompt failures) sooner and
// adjust its mental model of the codebase before the next batch.
// Trade-off: more planner round-trips but less wasted worker work.
const MAX_TODOS_PER_BATCH = 5;
export const PlannerResponseSchema = z.array(PlannerTodoSchema).max(MAX_TODOS_PER_BATCH);
registerParserSchema("planner", PlannerResponseSchema);

export interface PlannerTodoInput {
  /** #237 (2026-04-28): "hunks" (default) or "build". Hunks workers
   *  emit a {hunks:[...]} JSON envelope and the runner applies them.
   *  Build workers run a shell command via opencode's bash tool and
   *  the runner commits whatever changed. */
  kind?: "hunks" | "build";
  description: string;
  expectedFiles: string[];
  /** #237: only set when kind="build". The shell command the
   *  swarm-builder agent will execute via opencode bash. Gated by
   *  buildCommandAllowlist before dispatch. */
  command?: string;
  // Unit 44b: optional anchor strings. Forwarded into Board.postTodo
  // verbatim; resolved at worker-prompt build time.
  expectedAnchors?: string[];
  // Task #70: optional symbol names the runner verifies exist in
  // expectedFiles before posting the todo. Drop-on-mismatch.
  expectedSymbols?: string[];
  // Phase 5c of #243: planner-emitted tag preference. The runner's
  // claim selector reads it; absent = no preference.
  preferredTag?: string;
  // 2026-05-02 (auto-rollback decision #1): explicit criterion
  // attribution. Each todo declares which contract criterion ID(s) it
  // serves. Required for per-criterion rollback (decision #2) — without
  // this we'd have to infer attribution post-hoc from expectedFiles
  // intersection, which is fragile when todos touch overlapping files.
  // Optional for back-compat; unset = no auto-rollback eligibility for
  // this todo's commits.
  criteria?: string[];
}

export type PlannerParseResult =
  | { ok: true; todos: PlannerTodoInput[]; dropped: PlannerDropped[] }
  | { ok: false; reason: string };

export interface PlannerDropped {
  reason: string;
  raw: unknown;
}

// The planner commonly wraps its answer in ```json ... ``` fences, or prefaces
// it with prose ("Here is the plan: [...]"). Try increasingly-loose extraction
// only when the raw input fails to parse — otherwise valid top-level objects
// like `{"description":...,"expectedFiles":[...]}` get chewed up into their
// inner arrays and silently "succeed".
function stripFences(raw: string): string | null {
  const s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  const innerFence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (innerFence) return innerFence[1].trim();
  // Prose-then-array: `Here is the plan: [...] Let me know!` — slice between
  // the first '[' and the last ']'. Only meaningful if there's prose before
  // the opening bracket (firstBracket > 0); otherwise we'd just re-return s.
  const firstBracket = s.indexOf("[");
  const lastBracket = s.lastIndexOf("]");
  if (firstBracket > 0 && lastBracket > firstBracket) {
    return s.slice(firstBracket, lastBracket + 1);
  }
  return null;
}

/**
 * Coerce common planner shape mistakes so schema-dropped todos can still land
 * (d279548d: 5 schema-dropped → no-progress with zero board work).
 */
export function coercePlannerTodoItem(item: unknown): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  const o: Record<string, unknown> = { ...(item as Record<string, unknown>) };

  // Aliases → description
  if (typeof o.description !== "string" || !o.description.trim()) {
    for (const k of ["task", "todo", "title", "summary", "goal", "action"] as const) {
      if (typeof o[k] === "string" && (o[k] as string).trim()) {
        o.description = (o[k] as string).trim();
        break;
      }
    }
  }

  // expectedFiles aliases / string → array
  if (!Array.isArray(o.expectedFiles)) {
    if (typeof o.expectedFiles === "string" && o.expectedFiles.trim()) {
      o.expectedFiles = [o.expectedFiles.trim()];
    } else if (typeof o.file === "string" && o.file.trim()) {
      o.expectedFiles = [o.file.trim()];
    } else if (typeof o.path === "string" && o.path.trim()) {
      o.expectedFiles = [o.path.trim()];
    } else if (Array.isArray(o.files)) {
      o.expectedFiles = o.files;
    } else if (Array.isArray(o.paths)) {
      o.expectedFiles = o.paths;
    } else if (Array.isArray(o.targetFiles)) {
      o.expectedFiles = o.targetFiles;
    }
  }

  // Strip *accidental* trailing slashes on file paths ("src/app.ts/") only.
  // Bare directories ("src/") stay invalid so Zod still drops them.
  if (Array.isArray(o.expectedFiles)) {
    o.expectedFiles = o.expectedFiles
      .map((p) => {
        if (typeof p !== "string") return p;
        let s = p.trim();
        if (/\.[A-Za-z0-9]{1,12}[/\\]+$/.test(s)) {
          s = s.replace(/[/\\]+$/, "");
        }
        return s;
      })
      .filter((p) => typeof p === "string" && p.length > 0);
  }

  // build without command → hunks
  if (o.kind === "build" && (typeof o.command !== "string" || !String(o.command).trim())) {
    delete o.kind;
    delete o.command;
  }

  // Infer files from description text when still missing
  if (
    (!Array.isArray(o.expectedFiles) || o.expectedFiles.length === 0)
    && typeof o.description === "string"
  ) {
    const mentioned = extractFileMentions(o.description);
    if (mentioned.length > 0) {
      o.expectedFiles = mentioned.slice(0, 2);
    }
  }

  return o;
}

/** Filename-like tokens from free text (HTML modules, src paths, etc.). */
export function extractFileMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Paths with extensions; allow digits_name.html module style
  const re =
    /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:html?|tsx?|jsx?|mjs|cjs|json|md|css|py|go|rs|java|kt|swift|yml|yaml|toml|sh|bash|txt))\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1]!.replace(/\\/g, "/");
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Second-chance salvage for schema-dropped raw items + free-text file tokens,
 * optionally rebound against a known repo file list.
 */
export function salvagePlannerTodosFromDropped(
  dropped: readonly PlannerDropped[],
  repoFiles?: readonly string[],
): PlannerTodoInput[] {
  const todos: PlannerTodoInput[] = [];
  const repoSet = new Set((repoFiles ?? []).map((f) => f.replace(/\\/g, "/")));
  const hasRepo = repoSet.size > 0;

  for (const d of dropped) {
    const coerced = coercePlannerTodoItem(d.raw);
    const pre = lenientPreprocess(coerced, {
      maxDescription: 500,
      maxExpectedFiles: 2,
      maxExpectedAnchors: ANCHOR_MAX_PER_TODO,
      maxExpectedSymbols: SYMBOLS_MAX_PER_TODO,
      maxPreferredTag: 40,
      maxCriteria: CRITERIA_PER_TODO_MAX,
    });
    const v = PlannerTodoSchema.safeParse(pre);
    if (v.success) {
      const isBuild = v.data.kind === "build";
      todos.push({
        kind: v.data.kind ?? "hunks",
        description: v.data.description,
        expectedFiles: v.data.expectedFiles,
        ...(isBuild ? { command: v.data.command } : {}),
        expectedAnchors: v.data.expectedAnchors,
        expectedSymbols: v.data.expectedSymbols,
        ...(v.data.preferredTag ? { preferredTag: v.data.preferredTag } : {}),
        ...(v.data.criteria && v.data.criteria.length > 0 ? { criteria: v.data.criteria } : {}),
      });
      continue;
    }

    // Aggressive: pull description + any file token that exists in repoFiles
    if (typeof d.raw === "object" && d.raw !== null && !Array.isArray(d.raw)) {
      const raw = d.raw as Record<string, unknown>;
      let desc =
        typeof raw.description === "string"
          ? raw.description
          : typeof raw.task === "string"
            ? raw.task
            : typeof raw.title === "string"
              ? raw.title
              : "";
      if (!desc.trim()) continue;
      desc = desc.trim().slice(0, 500);
      const candidates = [
        ...extractFileMentions(desc),
        ...extractFileMentions(JSON.stringify(raw).slice(0, 2000)),
      ];
      const files: string[] = [];
      for (const c of candidates) {
        const norm = c.replace(/\\/g, "/");
        if (hasRepo) {
          if (repoSet.has(norm) && !files.includes(norm)) files.push(norm);
          else {
            const base = norm.split("/").pop()!;
            const hit = [...repoSet].find((f) => f === base || f.endsWith("/" + base));
            if (hit && !files.includes(hit)) files.push(hit);
          }
        } else if (!files.includes(norm)) {
          files.push(norm);
        }
        if (files.length >= 2) break;
      }
      if (files.length === 0) continue;
      todos.push({
        kind: "hunks",
        description: desc,
        expectedFiles: files.slice(0, 2),
      });
    }
  }
  return softCap(todos, MAX_TODOS_PER_BATCH);
}

function todoFromValidated(v: z.infer<typeof PlannerTodoSchema>): PlannerTodoInput {
  const isBuild = v.kind === "build";
  return {
    kind: v.kind ?? "hunks",
    description: v.description,
    expectedFiles: v.expectedFiles,
    ...(isBuild ? { command: v.command } : {}),
    expectedAnchors: v.expectedAnchors,
    expectedSymbols: v.expectedSymbols,
    ...(v.preferredTag ? { preferredTag: v.preferredTag } : {}),
    ...(v.criteria && v.criteria.length > 0 ? { criteria: v.criteria } : {}),
  };
}

export function parsePlannerResponse(raw: string): PlannerParseResult {
  if (raw.trim().length === 0) {
    return { ok: false, reason: "empty response — model produced no output after stripping thinking tags" };
  }
  const envelope = parseJsonEnvelope(raw);
  if (!envelope.ok) {
    return { ok: false, reason: envelope.reason };
  }
  const parsed = envelope.value;
  let items: unknown[];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as Record<string, unknown>).todos)
  ) {
    // {"todos":[...]} envelope — common model habit
    items = (parsed as { todos: unknown[] }).todos;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as Record<string, unknown>).items)
  ) {
    items = (parsed as { items: unknown[] }).items;
  } else if (
    // 2026-05-01 (#121): leniency — when the planner emits a single
    // todo-shaped object (has "description" field) instead of wrapping
    // it in [...], wrap it for them. The per-item walk below validates
    // each entry against PlannerTodoSchema, so a malformed object just
    // lands in `dropped` with a clean reason — no risk of accepting
    // garbage. Avoids burning a repair turn for a model error that's
    // clearly recoverable. Live observed: planner returned a valid
    // one-todo object, parser rejected, repair prompt fired, repaired
    // response was [] → run no-progress'd despite the original being
    // usable.
    parsed &&
    typeof parsed === "object" &&
    ("description" in (parsed as Record<string, unknown>)
      || "task" in (parsed as Record<string, unknown>)
      || "title" in (parsed as Record<string, unknown>))
  ) {
    items = [parsed];
  } else {
    return { ok: false, reason: `expected top-level JSON array, got ${typeof parsed}` };
  }
  const todos: PlannerTodoInput[] = [];
  const dropped: PlannerDropped[] = [];
  for (const item of items) {
    const coerced = coercePlannerTodoItem(item);
    let itemProcessed = lenientPreprocess(coerced, {
      maxDescription: 500,
      maxExpectedFiles: 2,
      maxExpectedAnchors: ANCHOR_MAX_PER_TODO,
      maxExpectedSymbols: SYMBOLS_MAX_PER_TODO,
      maxPreferredTag: 40,
      maxCriteria: CRITERIA_PER_TODO_MAX,
    });
    const v = PlannerTodoSchema.safeParse(itemProcessed);
    if (v.success) {
      todos.push(todoFromValidated(v.data));
    } else {
      const reason = v.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      dropped.push({ reason, raw: item });
    }
  }

  // Second chance: salvage schema-dropped items with aggressive coerce.
  if (dropped.length > 0 && todos.length < MAX_TODOS_PER_BATCH) {
    const salvaged = salvagePlannerTodosFromDropped(dropped);
    const seen = new Set(todos.map((t) => t.description + "|" + t.expectedFiles.join(",")));
    for (const t of salvaged) {
      const key = t.description + "|" + t.expectedFiles.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      todos.push(t);
      if (todos.length >= MAX_TODOS_PER_BATCH) break;
    }
  }

  // Soft-cap: if more valid todos survived than the per-batch max, keep the
  // first N rather than rejecting the entire response.
  const cappedTodos = softCap(todos, MAX_TODOS_PER_BATCH);
  return { ok: true, todos: cappedTodos, dropped };
}

// ---------------------------------------------------------------------------
// Prompts. Kept in this module so there's one source of truth for the shape
// the planner is asked to produce and the shape we parse.
// ---------------------------------------------------------------------------

export const PLANNER_SYSTEM_PROMPT = [
  "You are the PLANNER. Emit a short batch of atomic TODOs for workers.",
  "",
  "TOOLS: read, grep, glob, list. Prefer REPO FILE LIST / README / catalog / excerpts in the user message; tool-call only to verify symbols or paths.",
  "Before TODOs that edit an existing symbol: grep it in expectedFiles. Missing → don't invent it. Found → put names in expectedSymbols (runner drops missing symbols).",
  "",
  "RULES:",
  "1. Final response is a JSON array of todos (not an object):",
  ...JSON_ONLY_FINAL_RULE_LINES.map((line) => `   ${line}`),
  "2. Element shape: {\"description\": string, \"expectedFiles\": string[]} plus optional fields below.",
  "3. `description`: one imperative sentence, ≤500 chars. Concrete file CHANGE only — DO NOT emit read-only TODOs (read/analyze/review/explore).",
  "4. `expectedFiles`: 1–2 repo-relative FILE paths (never directories). Ground in REPO FILE LIST (existing path, or new file under a listed parent).",
  "5. Independently completable. Max 5 TODOs per batch; [] if nothing useful. One TODO per file in a batch (new files OK with other files).",
  "6. Large-file middle edits: optional expectedAnchors (1–4 short unique substrings). Existing-symbol edits: optional expectedSymbols (1–4 names).",
  "7. Build-style when a project script is required: {\"kind\":\"build\",\"description\", \"expectedFiles\", \"command\"}. Default kind is hunks.",
  "8. Optional: preferredTag (must match AVAILABLE WORKER TAGS), criteria ([\"c1\",…]), contextFiles (read-only, max 3, not in expectedFiles).",
  "9. Verify work is not already done before emitting. Paths: repo-relative, no `..`.",
].join("\n");

export interface PlannerSeed {
  repoUrl: string;
  clonePath: string;
  topLevel: string[];
  // Phase 5c of #243: optional list of {tag, count} pairs for any
  // workers in the topology that carry a specialization tag. The
  // planner sees this in the AVAILABLE WORKER TAGS section of the
  // user prompt and may emit a `preferredTag` on each TODO to route
  // it to a matching worker. Absent / empty array → no tag section
  // rendered + planner emits no preferences.
  workerTags?: Array<{ tag: string; count: number }>;
  // Grounding Unit 6a: breadth-first listing of up to ~150 repo-relative
  // file paths (forward slashes), with common ignores stripped. Gives the
  // planner + first-pass-contract real structure to ground expectedFiles
  // against instead of guessing from top-level dirs alone. Empty when the
  // clone is unreadable — callers must tolerate that.
  repoFiles: string[];
  readmeExcerpt: string | null;
  // Unit 25: optional user-authored directive that shapes the first-pass
  // contract. When present, the contract MUST incorporate it (see
  // FIRST_PASS_CONTRACT_SYSTEM_PROMPT rule 11). When absent or empty, the
  // planner behaves exactly as before Unit 25 (backward-compat).
  userDirective?: string;
  // Unit 50: distilled prior run on this same clone, when this run is a
  // resume (build-on-existing-clone work pattern, Units 47-51). The
  // first-pass-contract prompt's Rule 12 instructs the planner to AVOID
  // re-attempting met or wont-do criteria from the prior run, and to
  // build NEW criteria that extend or replace the unmet ones. Omitted
  // for fresh clones AND for resume runs that have no prior summary on
  // disk (e.g. a clone created outside this app).
  priorRunSummary?: PriorRunSummary;
  // Task #130: pre-rendered "Prior runs" block from .swarm-memory.jsonl.
  // Differs from priorRunSummary above: this is a persistent log of
  // lessons-learned across many runs (not just the immediately
  // preceding one), and it carries human-readable bullets the planner
  // produced post-completion — not the raw contract distillation.
  // Rendered already by memoryStore.renderMemoryForSeed so the planner
  // prompt builder doesn't have to know about MemoryEntry shape. Empty
  // string when there are no prior memories; renderer is no-op then.
  priorMemoryRendered?: string;
  // Task #177: design memory rendered (north-star + roadmap +
  // recent decisions). Read at planner-seed time + updated by a
  // post-run reflection pass. Empty when no design memory yet.
  priorDesignMemoryRendered?: string;
  // T188 (2026-05-04): code-context preloading. Pre-fetched head
  // excerpts (up to ~1500 chars each) of files the runner picked as
  // likely-target based on the directive's keywords + repo structure.
  // The planner sees actual content, not just file names — cuts the
  // "todo proposed against wrong file" failure mode where the
  // planner guessed wrong because it had no signal beyond filename.
  // Empty when gather failed / no directive / no matches found.
  codeContextExcerpts?: ReadonlyArray<{ path: string; excerpt: string }>;
  /** T198h (2026-05-04): test-driven todos. When true, planner
   *  prompt requires a `verify` step per todo (e.g., run a specific
   *  test file/command) so the worker's commit gets a measurable
   *  pass/fail signal beyond "did the model emit JSON." First-cut:
   *  pushes EXISTING tests; doesn't generate new failing tests.
   *  Optional — absent → planner behaves as before. */
  testDrivenTodos?: boolean;
  /** T198i (2026-05-04): parallel-hypothesis instruction. When true,
   *  the planner prompt asks for 2-3 ALTERNATIVE approaches to any
   *  unmet criterion from the prior auditor verdict. First-cut:
   *  sequential todos (next cycle picks whichever lands first by
   *  examining commit landed). Optional — absent → planner behaves
   *  as before. */
  parallelHypothesis?: boolean;
  // Ambitious idea: lightweight system map for broad understanding (like Context Oracle)
  systemMap?: string;
  /** True when webTools or plannerTools are enabled for this run. */
  webToolsEnabled?: boolean;
  /** Set when goal-generation pre-pass ran with web/read tools (skips redundant research pre-pass). */
  goalPrePassWithWebTools?: boolean;
  /** Free-form web research brief from the pre-contract research pass. */
  researchNotes?: string;
  /** Mid-run suggest/ask messages from user chat (steer is in userDirective). */
  userChatBlock?: string;
  /** Existing API catalog + .env key names for dedup grounding. */
  endpointCatalogBlock?: string;
  /** Cross-run project knowledge graph slice (swarm KG). */
  projectGraphSlice?: string;
  /** Prior explore turns from contract/todos/council — injected to skip repo re-tours. */
  explorationCache?: import("@ollama-swarm/shared/explorationCache").ExplorationCacheEntry[];
}

/** Shared research-tools guidance for planner/worker prompts. */
export function buildResearchToolsNote(enabled: boolean): string {
  if (!enabled) return "";
  return [
    "=== RESEARCH TOOLS ===",
    "Local first: use read / grep / list / glob for anything inside the clone (paths like src/data/panelRegistry.js).",
    "Never invent URLs: no raw.githubusercontent.com/your-org/..., no example.com, no file:// — those always fail.",
    "web_search: discover official endpoints; if search fails, do NOT retry the same query — web_fetch known .gov/.eu/bis.org/imf.org/worldbank.org URLs or stay local.",
    "web_fetch: only real https:// URLs to primary/official sources; cite URLs; note contradictions.",
    "=== end RESEARCH TOOLS ===",
  ].join("\n");
}

export function buildResearchNotesBlock(notes?: string): string {
  if (!notes || notes.trim().length === 0) return "";
  return [
    "",
    "=== PRIOR WEB RESEARCH (from pre-pass — cite these sources in your output) ===",
    notes.trim(),
    "=== end PRIOR WEB RESEARCH ===",
    "",
  ].join("\n");
}

// Unit 50: slim, capped distillation of the previous run's summary.json
// for the planner's seed. Only carries the contract — not commits/agent
// stats — because that's what the planner needs to avoid re-attempting
// resolved work. Rationales are truncated to bound the prompt size
// (mirrors AUDITOR_RATIONALE_MAX_CHARS from Unit 46b).
export interface PriorRunSummary {
  startedAtIso: string;
  missionStatement: string;
  criteria: Array<{
    id: string;
    description: string;
    status: "met" | "unmet" | "wont-do";
    rationale?: string;
    expectedFiles: string[];
  }>;
}

// Unit 50: per-rationale cap. Same magnitude as Unit 46b's auditor cap.
// 20 criteria × 400 chars = ~8 KB max for the prior block — bounded.
export const PRIOR_RATIONALE_MAX_CHARS = 400;

export function buildPlannerUserPrompt(seed: PlannerSeed, contract?: { missionStatement: string; criteria: Array<{ description: string; expectedFiles: string[] }> }, model?: string): string {
  const budget = getModelBudget(model);
  const tree = seed.topLevel.length > 0 ? seed.topLevel.join(", ") : "(empty)";
  const maxRepoFiles = budget.fullFileMode ? 500 : 150;
  const fileList = seed.repoFiles.length > 0
    ? seed.repoFiles.slice(0, maxRepoFiles).join("\n") + (seed.repoFiles.length > maxRepoFiles ? `\n... and ${seed.repoFiles.length - maxRepoFiles} more` : "")
    : "(no files listed — clone may be unreadable; use top-level entries above as a weaker guide)";
  const grounding = buildPlannerGroundingBlocks(seed, model);
  // #231 follow-up (2026-04-27 evening): include the user's directive
  // AND the just-produced contract directly in the todos prompt. RCA
  // from runs af27f55c / 07e37525 / 00347ab2 found the planner was
  // returning empty arrays because it had no actionable target — the
  // contract was produced separately and never fed back. The user
  // directive was in the seed but never rendered. Now both are
  // explicit. Per HARD RULE 6 the planner returns [] only when there's
  // genuinely nothing to do; with directive + criteria visible it can
  // ground todos against them.
  // Prefer shared blackboard directive block when the user set one.
  // When absent, keep the historical default "improve the codebase"
  // seed so todos still have a target (empty-array failure mode).
  const sharedDirective = buildBlackboardDirectiveBlock(seed.userDirective, {
    labelSuffix: "(the work the user wants done)",
    authoritative: true,
  });
  const directiveBlock =
    sharedDirective.length > 0
      ? sharedDirective.join("\n") + "\n"
      : `=== USER DIRECTIVE (no specific directive provided — default: improve the codebase) ===\nAudit this repository for code quality, correctness, and maintainability. Propose concrete improvements: fix bugs, reduce duplication, improve error handling, and add tests where coverage is weak. Each TODO should change or add specific files.\n=== end USER DIRECTIVE ===\n\n`;
  const contractBlock = contract
    ? [
        "=== CONTRACT (just produced; your TODOs should make these criteria met) ===",
        `Mission: ${contract.missionStatement}`,
        ...contract.criteria.map((c, i) =>
          `  ${i + 1}. ${c.description}${c.expectedFiles.length > 0 ? ` [files: ${c.expectedFiles.join(", ")}]` : ""}`,
        ),
        "=== end CONTRACT ===",
        "",
      ].join("\n")
    : "";
  // Phase 5c of #243: render the available worker tags so the planner
  // can emit `preferredTag` per TODO. Renders nothing when no workers
  // carry a tag — keeps the prompt clean for default topologies.
  const workerTagsBlock =
    seed.workerTags && seed.workerTags.length > 0
      ? [
          "=== AVAILABLE WORKER TAGS (per topology, planner may set TODO.preferredTag to one of these) ===",
          ...seed.workerTags.map(({ tag, count }) =>
            `  • ${tag} (${count} ${count === 1 ? "worker" : "workers"})`,
          ),
          "=== end WORKER TAGS ===",
          "",
        ].join("\n")
      : "";
  // T188 (2026-05-04): code-context preloading. When the runner pre-
  // fetched head excerpts of likely-target files based on directive
  // keywords, surface them so the planner sees actual content not
  // just file names. Cuts the "todo proposed against wrong file"
  // failure mode where the planner confidently dispatched against
  // src/foo.ts because the name matched, when src/bar.ts was the
  // actual relevant file. Empty/absent → no block rendered.
  return [
    grounding.prefix + directiveBlock + `Repository: ${seed.repoUrl}`,
    `Clone path: ${seed.clonePath}`,
    `Top-level entries: ${tree}`,
    "",
    contractBlock,
    workerTagsBlock,
    "=== REPO FILE LIST (up to 150 paths, BFS order, ignores applied) ===",
    fileList,
    "=== end REPO FILE LIST ===",
    "",
    "=== README excerpt (first 4000 chars) ===",
    grounding.readme,
    "=== end README ===",
    "",
    grounding.codeContextBlock,
    grounding.researchToolsNote,
    grounding.researchNotesBlock,
    seed.webToolsEnabled ? "\n" : "",
    // T198h (2026-05-04): test-driven todo expansion. When opt-in,
    // the planner is asked to surface a verification step per todo
    // so the worker's commit gets a measurable signal beyond
    // "did the model emit JSON." Pushes EXISTING tests in the repo;
    // doesn't generate new failing tests (the test-scaffolding
    // generator is days of work — deferred).
    seed.testDrivenTodos
      ? [
          "**TEST-DRIVEN TODO MODE (T198h):** For each TODO, include in the description a `verify:` clause naming a SPECIFIC test file or command that will pass if the TODO is correctly implemented. Examples:",
          "  description: \"Add bcrypt hashing to src/auth/hash.ts (verify: `node --test test/auth-hash.test.ts` passes)\"",
          "  description: \"Fix off-by-one in src/util/range.ts (verify: `npm test -- range` passes 5/5 cases)\"",
          "If the repo has NO test infrastructure for the TODO's area, mark `verify: manual — describe what success looks like` instead of inventing a test that won't run.",
          "",
        ].join("\n")
      : "",
    // T198i (2026-05-04): parallel-hypothesis instruction. When the
    // prior auditor verdict was "partial" + this flag is on, ask the
    // planner to propose 2-3 ALTERNATIVE approaches for the unmet
    // criterion (sequential todos; auditor picks the best after).
    seed.parallelHypothesis
      ? [
          "**PARALLEL-HYPOTHESIS MODE (T198i):** When a criterion was last audited as `partial`, propose 2-3 ALTERNATIVE TODOs for it (different angles, file targets, or implementations). Tag each with `[hypothesis: A]`, `[hypothesis: B]`, `[hypothesis: C]` in the description. Workers run them sequentially; the auditor picks whichever lands the criterion. If no criterion is `partial`, ignore this rule and propose normal TODOs.",
          "",
        ].join("\n")
      : "",
    "Using the directive + contract + file list above, output your JSON array of TODOs now. Each TODO should be a concrete step toward making the contract criteria met.",
    "Remember: JSON array, no prose, <=2 files per TODO. Prefer paths that appear in the REPO FILE LIST; if creating a new file, its parent directory should appear there.",
  ].join("\n");
}

export function buildRepairPrompt(
  previousResponse: string,
  parseError: string,
  auditorNote?: string,
): string {
  const auditorBlock = auditorNote?.trim()
    ? [
        "",
        "=== AUDITOR DIAGNOSTIC (read and apply — planner role stays with you) ===",
        auditorNote.trim(),
        "=== end AUDITOR DIAGNOSTIC ===",
        "",
      ]
    : [];
  return [
    "Your previous response could not be parsed as the required JSON array.",
    `Parser error: ${parseError}`,
    ...auditorBlock,
    "Your previous response was:",
    "--- BEGIN PREVIOUS RESPONSE ---",
    previousResponse,
    "--- END PREVIOUS RESPONSE ---",
    "",
    "You have already explored the repo. Do NOT emit more XML pseudo-tool-calls or file dumps.",
    "Respond now with ONLY a JSON array matching the schema:",
    '[{"description": "one sentence", "expectedFiles": ["path1", "path2"]}, ...]',
    "",
    "No prose. No markdown fences. No <think> tags. No commentary. Just the JSON array.",
  ].join("\n");
}

const DESCRIPTION_MAX = 500;

