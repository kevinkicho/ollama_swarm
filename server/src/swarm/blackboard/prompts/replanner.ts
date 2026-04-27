import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema. The replanner is shown a stale TODO + current file state and must
// produce ONE of two shapes:
//
//   Revise: { "revised": { "description": string, "expectedFiles": string[] } }
//   Skip:   { "skip": true, "reason": string }
//
// We keep the two branches distinct (not a single object with optional fields)
// so the model has to commit to one intent. A mixed response is rejected by
// the union match below.
// ---------------------------------------------------------------------------

// File paths only — see planner.ts for the motivating incident. Replanner
// output replaces a stale todo's expectedFiles, so the same rule applies.
const filePathEntry = z
  .string()
  .trim()
  .min(1)
  .refine((p) => !p.endsWith("/") && !p.endsWith("\\"), {
    message: "must be a file path, not a directory (no trailing / or \\)",
  });

// Unit 44b: same anchor schema as planner.ts. Replanner can revise the
// anchor set when the original anchors didn't match the post-drift
// file. Keep the cap shape identical so prompts stay parallel.
const REPLAN_ANCHOR_MAX_CHARS = 200;
const REPLAN_ANCHOR_MAX_PER_TODO = 4;
const replanAnchorEntry = z.string().trim().min(1).max(REPLAN_ANCHOR_MAX_CHARS);

const RevisedBody = z.object({
  description: z.string().trim().min(1).max(500),
  expectedFiles: z.array(filePathEntry).min(1).max(2),
  expectedAnchors: z.array(replanAnchorEntry).max(REPLAN_ANCHOR_MAX_PER_TODO).optional(),
});

const RevisedSchema = z.object({ revised: RevisedBody });
const SkipSchema = z.object({
  skip: z.literal(true),
  reason: z.string().trim().min(1).max(500),
});

const ReplannerResponseSchema = z.union([RevisedSchema, SkipSchema]);

export type ReplannerParseResult =
  | {
      ok: true;
      action: "revised";
      description: string;
      expectedFiles: string[];
      // Unit 44b: optional anchor revision. undefined → keep prior; empty
      // array (after parsing) → schema rejects, so undefined is the only
      // way to leave anchors unchanged.
      expectedAnchors?: string[];
    }
  | { ok: true; action: "skip"; reason: string }
  | { ok: false; reason: string };

// Task #204: shared stripFences helper across 6 prompt parsers.
// Same extraction pattern: fenced first, then prose-surround slice.
import { extractJsonFromText as stripFences } from "../../extractJson.js";

export function parseReplannerResponse(raw: string): ReplannerParseResult {
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

  if (Array.isArray(parsed)) {
    return { ok: false, reason: "expected top-level JSON object, got array" };
  }

  const v = ReplannerResponseSchema.safeParse(parsed);
  if (!v.success) {
    const reason = v.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }

  if ("revised" in v.data) {
    return {
      ok: true,
      action: "revised",
      description: v.data.revised.description,
      expectedFiles: [...v.data.revised.expectedFiles],
      expectedAnchors: v.data.revised.expectedAnchors
        ? [...v.data.revised.expectedAnchors]
        : undefined,
    };
  }
  return { ok: true, action: "skip", reason: v.data.reason };
}

// ---------------------------------------------------------------------------
// Prompts. The planner agent is reused with a different prompt — see
// docs/known-limitations.md for why there is no dedicated replanner agent.
// ---------------------------------------------------------------------------

export const REPLANNER_SYSTEM_PROMPT = [
  "You are the REPLANNER for a swarm of coding agents working on a cloned repository.",
  "A previously-posted TODO became STALE — its claim expired, a CAS mismatch rejected its commit, or another agent's edits invalidated its assumptions.",
  "You are shown the original TODO, the reason it went stale, and the CURRENT contents of its expected files. You must produce exactly one JSON object that either revises the TODO so a fresh agent can complete it, OR skips it because it is no longer needed.",
  "",
  "TOOLS (Unit 37): You have `read`, `grep`, `glob`, `list` on the cloned repo. When the stale reason is 'CAS mismatch' or 'hunk apply failed', the current file state in the user prompt reflects what ANOTHER agent committed while this TODO was in flight. USE THE TOOLS to see what changed — read the related files, grep for the specific pattern the original TODO targeted. Your revised TODO needs to work against the NEW state, not the pre-drift state.",
  "",
  "HARD RULES:",
  "1. Output ONLY a JSON object. No prose. No markdown fences. No commentary before or after.",
  "1a. (2026-04-27) Do NOT emit raw XML tool-call syntax (e.g. `<read path='...' />`) AS the response — that's the SDK's internal tool-call format and parsing it as JSON fails closed. Use the actual tool functions; the SDK invokes them transparently. Visible response MUST be only the JSON object.",
  "2. Shape A (revise): {\"revised\": {\"description\": string, \"expectedFiles\": string[]}}",
  "3. Shape B (skip):   {\"skip\": true, \"reason\": string}",
  "4. Choose exactly one shape. Never include both `revised` and `skip` keys in the same response.",
  "5. `description` is one imperative sentence.",
  "6. `expectedFiles` lists 1 or 2 repo-relative paths. NEVER more than 2.",
  "7. Paths must be relative to the repo root. Never use absolute paths or `..`.",
  "8. `expectedFiles` entries are FILE paths, never directories. Do NOT emit `src/`, `__tests__/`, or any path ending in `/` or `\\` — the parser rejects them and the revision is lost. If the original stale TODO pointed at a directory, revise to the specific files you see in the current contents or skip.",
  "9. (Unit 44b) When revising a row-level edit on a large file, you MAY include `expectedAnchors`: an array of 1-4 short verbatim substrings (≤ 200 chars each) the runner will use to inject ±25 lines of context around each match into the next worker's prompt. Use this when the prior attempt failed because the target row was in the file's omitted middle region. Omit `expectedAnchors` to keep whatever the original TODO had.",
  "",
  "Pick SKIP when: the current file contents already satisfy the original TODO, the original intent no longer applies to the repo as it stands now, or retrying would fail for the same reason the previous attempt failed.",
  "Pick REVISE when: the work still needs doing but the scope, files, or wording needs to shift to match what you see in the files NOW. Prefer shrinking scope over widening it — if the previous attempt was too large, split it and keep only the smaller half.",
].join("\n");

export interface ReplannerSeed {
  todoId: string;
  originalDescription: string;
  originalExpectedFiles: string[];
  staleReason: string;
  // null = file does not exist on disk right now.
  fileContents: Record<string, string | null>;
  replanCount: number;
}

export function buildReplannerUserPrompt(seed: ReplannerSeed): string {
  const parts: string[] = [
    `Stale TODO id: ${seed.todoId}`,
    `Original description: ${seed.originalDescription}`,
    `Original expected files: ${seed.originalExpectedFiles.join(", ")}`,
    `Stale reason: ${seed.staleReason}`,
    `Prior replan attempts: ${seed.replanCount}`,
    "",
  ];
  for (const f of seed.originalExpectedFiles) {
    const content = seed.fileContents[f];
    if (content === null || content === undefined) {
      parts.push(`=== ${f} (does not exist on disk right now) ===`);
    } else {
      parts.push(`=== Current contents of ${f} ===`);
      parts.push(content);
      parts.push(`=== end ${f} ===`);
    }
    parts.push("");
  }
  parts.push("Output your JSON object now. Remember: one shape only, no prose, <=2 files if revising.");
  return parts.join("\n");
}

export function buildReplannerRepairPrompt(previousResponse: string, parseError: string): string {
  return [
    "Your previous response could not be parsed as the required JSON object.",
    `Parser error: ${parseError}`,
    "",
    "Your previous response was:",
    "--- BEGIN PREVIOUS RESPONSE ---",
    previousResponse,
    "--- END PREVIOUS RESPONSE ---",
    "",
    "Respond now with ONLY a JSON object matching one of:",
    '  {"revised": {"description": "one sentence", "expectedFiles": ["path1"]}}',
    '  {"skip": true, "reason": "why this is no longer worth doing"}',
    "",
    "No prose. No markdown fences. No commentary. Just the JSON object.",
  ].join("\n");
}
