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

const PlannerTodoSchema = z.object({
  description: z.string().trim().min(1).max(500),
  expectedFiles: z.array(filePathEntry).min(1).max(2),
});

const PlannerResponseSchema = z.array(PlannerTodoSchema).max(20);

export interface PlannerTodoInput {
  description: string;
  expectedFiles: string[];
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
      todos.push({ description: v.data.description, expectedFiles: v.data.expectedFiles });
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
    return { ok: false, reason: `too many todos (max 20), got ${todos.length}` };
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
  "HARD RULES:",
  "1. Output ONLY a JSON array. No prose. No markdown fences. No commentary before or after.",
  "2. Each element MUST be an object of shape: {\"description\": string, \"expectedFiles\": string[]}.",
  "3. `description` is one imperative sentence (e.g., \"Add a readme section explaining the API.\").",
  "4. `expectedFiles` lists 1 or 2 repo-relative paths the agent will need to touch. NEVER more than 2.",
  "5. Each TODO must be independently completable without coordinating with another agent.",
  "6. If the repo is trivial, already complete, or there is nothing meaningful to add, return an empty array [].",
  "7. Maximum 20 TODOs per response.",
  "8. `expectedFiles` entries are FILE paths, never directories. Do NOT emit `src/`, `__tests__/`, `docs/`, or any path ending in `/` or `\\`. If the TODO covers a whole directory, pick the specific files it will touch (e.g., `src/lib/a.ts`, `src/lib/b.ts`) or split it into smaller TODOs. Directory entries are rejected by the parser and the TODO is dropped.",
  "9. Ground every `expectedFiles` entry in the REPO FILE LIST provided in the user message. Each entry MUST either (a) appear verbatim in the list (for edits to existing files), or (b) be a new file whose parent directory appears in the list (for adding a new file to a known location). Do NOT invent paths whose parent directory is not in the list — the worker's file-hash pass will fail on EISDIR/ENOENT and stall the run.",
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
}

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
  return [
    `Repository: ${seed.repoUrl}`,
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
