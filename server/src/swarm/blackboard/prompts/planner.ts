import { z } from "zod";

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

const PlannerTodoSchema = z.object({
  description: z.string().trim().min(1).max(500),
  expectedFiles: z.array(filePathEntry).min(1).max(2),
  expectedAnchors: z.array(anchorEntry).max(ANCHOR_MAX_PER_TODO).optional(),
  expectedSymbols: z.array(symbolEntry).max(SYMBOLS_MAX_PER_TODO).optional(),
});

// Task #71 (2026-04-25): lowered cap from 20 → 5. Earlier blackboard
// runs surfaced a "skip cascade" pattern — the planner posted up to 20
// todos based on assumed code structure ("Agent class constructor",
// "Brain class") and 16 of 20 got declined by workers because the
// referenced symbols didn't exist. Smaller batches let the planner
// see worker feedback (declines, repair-prompt failures) sooner and
// adjust its mental model of the codebase before the next batch.
// Trade-off: more planner round-trips but less wasted worker work.
const MAX_TODOS_PER_BATCH = 5;
const PlannerResponseSchema = z.array(PlannerTodoSchema).max(MAX_TODOS_PER_BATCH);

export interface PlannerTodoInput {
  description: string;
  expectedFiles: string[];
  // Unit 44b: optional anchor strings. Forwarded into Board.postTodo
  // verbatim; resolved at worker-prompt build time.
  expectedAnchors?: string[];
  // Task #70: optional symbol names the runner verifies exist in
  // expectedFiles before posting the todo. Drop-on-mismatch.
  expectedSymbols?: string[];
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

export function parsePlannerResponse(raw: string): PlannerParseResult {
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
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: `expected top-level JSON array, got ${typeof parsed}` };
  }
  const todos: PlannerTodoInput[] = [];
  const dropped: PlannerDropped[] = [];
  for (const item of parsed) {
    const v = PlannerTodoSchema.safeParse(item);
    if (v.success) {
      todos.push({
        description: v.data.description,
        expectedFiles: v.data.expectedFiles,
        expectedAnchors: v.data.expectedAnchors,
        expectedSymbols: v.data.expectedSymbols,
      });
    } else {
      const reason = v.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      dropped.push({ reason, raw: item });
    }
  }
  // Sanity: reject if the top-level array exceeds the max. The item-level
  // walk above keeps everything because it iterates parsed itself; instead
  // just cap valid todos here.
  const capResult = PlannerResponseSchema.safeParse(todos);
  if (!capResult.success) {
    return { ok: false, reason: `too many todos (max ${MAX_TODOS_PER_BATCH}), got ${todos.length}` };
  }
  return { ok: true, todos, dropped };
}

// ---------------------------------------------------------------------------
// Prompts. Kept in this module so there's one source of truth for the shape
// the planner is asked to produce and the shape we parse.
// ---------------------------------------------------------------------------

export const PLANNER_SYSTEM_PROMPT = [
  "You are the PLANNER for a swarm of coding agents working on a cloned repository.",
  "Your only job is to produce a short list of small, atomic TODOs that other agents will each implement independently.",
  "",
  "TOOLS (Unit 37): You have `read`, `grep`, `glob`, `list` tools on the cloned repo. USE THEM before emitting TODOs. Read the files your criteria name (so the TODO description can be specific), grep for existing implementations (so you don't duplicate work), list adjacent directories (so you name real paths). A TODO shaped around what's actually in the code succeeds; a TODO shaped around a guess fails at worker time.",
  "",
  "REQUIRED VERIFICATION (Task #69): The single biggest source of wasted work is TODOs premised on symbols that DON'T EXIST in the codebase. Common pattern: you assume `class Foo` exists with a `constructor` because the project name suggests OOP, but the codebase is functional (factory functions like `createFoo`). Before emitting a TODO that references an EXISTING symbol (a class, function, named export the worker is supposed to modify):",
  "  - GREP for the symbol in the expectedFile FIRST. Example: `grep -n 'class Agent' src/agent.ts`.",
  "  - If the grep returns 0 hits, the symbol does NOT exist — pick a different file, change the TODO to create the symbol fresh, or skip it entirely.",
  "  - If the grep returns hits, declare those symbol names in `expectedSymbols` (rule 11) so the runner's verification pass confirms them.",
  "  - Tool calls are CHEAP relative to a wasted worker round-trip. Use them.",
  "  - The runner now drops TODOs whose declared `expectedSymbols` aren't found in `expectedFiles` (Task #70). A confidently-declared symbol that doesn't exist will be silently dropped.",
  "",
  "HARD RULES:",
  "1. Output ONLY a JSON array. No prose. No markdown fences. No commentary before or after.",
  "2. Each element MUST be an object of shape: {\"description\": string, \"expectedFiles\": string[]}.",
  "3. `description` is one imperative sentence (e.g., \"Add a readme section explaining the API.\").",
  "4. `expectedFiles` lists 1 or 2 repo-relative paths the agent will need to touch. NEVER more than 2.",
  "5. Each TODO must be independently completable without coordinating with another agent.",
  "6. If the repo is trivial, already complete, or there is nothing meaningful to add, return an empty array [].",
  "7. Maximum 5 TODOs per response. Smaller is better — the replanner re-prompts you for more after these land, and a smaller initial batch lets you see worker feedback (declined / repaired / committed) before you commit to the next 5.",
  "8. `expectedFiles` entries are FILE paths, never directories. Do NOT emit `src/`, `__tests__/`, `docs/`, or any path ending in `/` or `\\`. If the TODO covers a whole directory, pick the specific files it will touch (e.g., `src/lib/a.ts`, `src/lib/b.ts`) or split it into smaller TODOs. Directory entries are rejected by the parser and the TODO is dropped.",
  "9. Ground every `expectedFiles` entry in the REPO FILE LIST provided in the user message. Each entry MUST either (a) appear verbatim in the list (for edits to existing files), or (b) be a new file whose parent directory appears in the list (for adding a new file to a known location). Do NOT invent paths whose parent directory is not in the list — the worker's file-hash pass will fail on EISDIR/ENOENT and stall the run.",
  "10. (Unit 44b) For TODOs that touch a SPECIFIC ROW or REGION of a large file (e.g., a single row in a 100-row markdown table, one entry in a 200-entry JSON object), include `expectedAnchors`: an array of 1-4 short verbatim substrings (≤ 200 chars each) that uniquely identify the target region. Workers see only HEAD + TAIL of files above 8 KB; anchors let the runner inject ±25 lines of context around each anchor so the worker can actually edit middle-region rows. Use grep/read first to confirm each anchor exists in the file. Examples: `\"| 7 | **ASE Holdings**\"`, `\"NVIDIA: { revenue:\"`. Omit `expectedAnchors` for whole-file edits, append-only TODOs, or files small enough to show in full.",
  "11. (Task #70) For TODOs that operate on EXISTING symbols (a function, class, or named export the worker is supposed to modify or document), include `expectedSymbols`: an array of 1-4 symbol names (≤ 200 chars each) the runner will word-boundary-grep in each expectedFile BEFORE posting the todo. If any symbol is missing from every expectedFile, the runner drops the todo with a finding — saves a wasted worker round-trip. Examples: `[\"createOrchestrator\"]`, `[\"AgentManager\", \"spawnAgent\"]`. OMIT for create-new-file TODOs (file doesn't exist yet) and for whole-file rewrites. Include for: \"add JSDoc to X\", \"add null guard to Y\", \"rename Z\", \"replace inline string with constant W\". When in doubt, include — being wrong about a symbol's existence is the planner's #1 failure mode.",
  "",
  "Paths must be relative to the repo root. Never use absolute paths or `..`.",
].join("\n");

export interface PlannerSeed {
  repoUrl: string;
  clonePath: string;
  topLevel: string[];
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

export function buildPlannerUserPrompt(seed: PlannerSeed): string {
  const tree = seed.topLevel.length > 0 ? seed.topLevel.join(", ") : "(empty)";
  const readme = seed.readmeExcerpt
    ? seed.readmeExcerpt.slice(0, 4000)
    : "(no README found at repo root)";
  // Grounding Unit 6a: show the real files. One path per line — less token-
  // efficient than comma-separated, but much easier for the model to scan
  // and quote verbatim into expectedFiles.
  const fileList = seed.repoFiles.length > 0
    ? seed.repoFiles.join("\n")
    : "(no files listed — clone may be unreadable; use top-level entries above as a weaker guide)";
  // Task #130: prepend persistent cross-run memory if present. Renderer
  // returns "" when there are no prior memories so this is a no-op on
  // fresh clones / first runs.
  const memoryBlock = seed.priorMemoryRendered ? `${seed.priorMemoryRendered}\n\n` : "";
  // Task #177: prepend design memory (north-star + roadmap + recent
  // decisions). Comes BEFORE the engineering memory because it sets
  // the long-horizon framing the planner should evaluate todos against.
  const designBlock = seed.priorDesignMemoryRendered
    ? `${seed.priorDesignMemoryRendered}\n\n` +
      "GUIDANCE: honor the north star + recent decisions when proposing TODOs. Prefer work that advances the roadmap. If a TODO would contradict a prior decision, propose updating the decision first instead.\n\n"
    : "";
  return [
    designBlock + memoryBlock + `Repository: ${seed.repoUrl}`,
    `Clone path: ${seed.clonePath}`,
    `Top-level entries: ${tree}`,
    "",
    "=== REPO FILE LIST (up to 150 paths, BFS order, ignores applied) ===",
    fileList,
    "=== end REPO FILE LIST ===",
    "",
    "=== README excerpt (first 4000 chars) ===",
    readme,
    "=== end README ===",
    "",
    "Using ONLY the information above, output your JSON array of TODOs now.",
    "Remember: JSON array, no prose, <=2 files per TODO. Prefer paths that appear in the REPO FILE LIST; if creating a new file, its parent directory should appear there.",
  ].join("\n");
}

export function buildRepairPrompt(previousResponse: string, parseError: string): string {
  return [
    "Your previous response could not be parsed as the required JSON array.",
    `Parser error: ${parseError}`,
    "",
    "Your previous response was:",
    "--- BEGIN PREVIOUS RESPONSE ---",
    previousResponse,
    "--- END PREVIOUS RESPONSE ---",
    "",
    "Respond now with ONLY a JSON array matching the schema:",
    '[{"description": "one sentence", "expectedFiles": ["path1", "path2"]}, ...]',
    "",
    "No prose. No markdown fences. No commentary. Just the JSON array.",
  ].join("\n");
}
