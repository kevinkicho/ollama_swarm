// Unit 35: critic agent at commit time.
//
// Between "worker returned valid hunks + CAS passed" and "write diffs to
// disk + record commit on the board", an independent critic agent judges
// whether the proposed change is SUBSTANTIVE or BUSYWORK. Busywork gets
// rejected — the todo goes stale, no disk mutation, no commit slot burned —
// and the replanner picks up a fresh angle. This is the anti-pyramid-of-
// tests layer from docs/autonomous-productivity.md — the auditor is too
// late to catch duplicate-content patterns across files because by then
// the criterion is already "met" (string-match on file changed).
//
// The critic prompt is intentionally SHAPED around a few specific failure
// modes we expect to see when the swarm is running autonomously for hours
// without human review, not around a general "is this good code?" judgment
// (which would be over-reach). An accept verdict means "this is not
// obviously busywork"; a reject verdict means "a human reviewing a PR
// from this agent would likely ask: is there even anything new here?"
//
// Envelope: ONE JSON object, {"verdict": "accept"|"reject", "rationale":
// "one sentence"}. Same stripFences + prose-unwrap tolerance as
// firstPassContract's parser.

import { z } from "zod";

const VerdictSchema = z.enum(["accept", "reject"]);

const CriticResponseSchema = z.object({
  verdict: VerdictSchema,
  rationale: z.string().trim().min(1).max(400),
});

export interface ParsedCriticResponse {
  verdict: "accept" | "reject";
  rationale: string;
}

export type CriticParseResult =
  | { ok: true; critic: ParsedCriticResponse }
  | { ok: false; reason: string };

// Same stripFences helper as firstPassContract — kept inline to avoid an
// import cycle and because the shape is small.
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

export function parseCriticResponse(raw: string): CriticParseResult {
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
  const v = CriticResponseSchema.safeParse(parsed);
  if (!v.success) {
    const reason = v.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }
  return { ok: true, critic: { verdict: v.data.verdict, rationale: v.data.rationale } };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const CRITIC_SYSTEM_PROMPT = [
  "You are the CRITIC. Another agent in this swarm just proposed a diff against a repo. Before the diff is committed, you decide whether it's SUBSTANTIVE or BUSYWORK.",
  "",
  "TOOLS (Unit 37): You have `read`, `grep`, `glob`, `list` on the cloned repo. USE THEM when judging patterns 1 (duplicate content) and 6 (regressions). Grep for existing near-identical content elsewhere in the repo; read sibling test files to see if the new tests assert something that's already asserted; list the parent directory of a newly-created file to check whether that directory already has 5 tiny near-clones. Verdict grounded in what's actually in the repo > verdict inferred from the diff alone.",
  "",
  "Your job is NOT to review every line of code. Your job is to catch a specific set of failure modes that tend to show up when an LLM swarm runs autonomously without human review:",
  "  1. DUPLICATE CONTENT — near-identical file bodies across multiple files (e.g. foo.test.ts and foo.bar.test.ts with the same test body), or near-identical sections within one file.",
  "  2. TESTS WITHOUT BEHAVIOR — test files whose assertions don't actually exercise the claimed feature (hard-coded expected values, trivially-true checks, empty test bodies, only describe blocks with no it calls).",
  "  3. RENAME / REORG ONLY — the diff moves or renames content without changing behavior or adding information.",
  "  4. STUB IMPLEMENTATIONS — functions that return null, throw 'not implemented', or are pure TODO comments, labelled as if they did something.",
  "  5. GENERIC DOCUMENTATION — prose that could apply to ANY project (\"This project is great\", lorem-ipsum-tier filler) rather than this specific repo.",
  "  6. REGRESSIONS — the diff removes substantive existing code (functions, tests, docs) without adding equivalent or better coverage elsewhere.",
  "",
  "If the diff hits ONE OR MORE of the six patterns above, verdict is \"reject\".",
  "If the diff advances the todo in a way that a human maintainer would NOT flag for rework, verdict is \"accept\".",
  "",
  "You are NOT evaluating: code style, test coverage completeness, naming bikeshedding, or whether a BETTER approach exists. The bar is \"not obviously busywork\", not \"the best possible version of this change\".",
  "",
  "OUTPUT SHAPE:",
  "Output ONLY a single JSON object: {\"verdict\": \"accept\" | \"reject\", \"rationale\": \"ONE sentence\"}.",
  "No prose, no fences, no commentary.",
  "When rejecting, the rationale MUST name which of the six patterns fired (e.g. \"reject — pattern 1 duplicate content: foo.test.ts and foo.bar.test.ts share the same assertion block\").",
  "When accepting, the rationale MUST cite the concrete thing the diff adds or changes (e.g. \"accept — adds a new export 'validateEmail' and a test exercising its null-handling path\").",
].join("\n");

export interface CriticSeedPriorCommit {
  todoId: string;
  description: string;
  files: string[];
}

export interface CriticSeedFileBeforeAfter {
  file: string;
  before: string | null; // null = file didn't exist before
  after: string;
}

export interface CriticSeed {
  /** Committing worker agent's id — so the critic can say "a peer proposed" with context. */
  proposingAgentId: string;
  /** The todo being worked on. */
  todoDescription: string;
  todoExpectedFiles: string[];
  /** The criterion this todo is linked to, if any — gives the critic the
   *  larger outcome context (often clarifies whether a diff is advancing
   *  the right thing). */
  criterionId?: string;
  criterionDescription?: string;
  /** Files the worker touched, with their pre-apply and post-apply
   *  content. The critic compares these to judge substance. */
  files: readonly CriticSeedFileBeforeAfter[];
  /** Recent prior commits (most recent first) — for cross-file duplicate
   *  detection ("has this agent done essentially the same thing to a
   *  different file already?"). Capped by the caller (see
   *  CRITIC_RECENT_COMMITS_MAX). */
  recentCommits: readonly CriticSeedPriorCommit[];
}

// Cap how many prior commits we show the critic — enough to catch same-
// session duplicates, small enough to keep the prompt bounded.
export const CRITIC_RECENT_COMMITS_MAX = 12;
// Cap how much file content we show per file — 8KB is in line with the
// auditor window (Unit 5b). Larger files get head-only truncation.
export const CRITIC_FILE_SNIPPET_MAX = 8_000;

function snippet(s: string): string {
  if (s.length <= CRITIC_FILE_SNIPPET_MAX) return s;
  return s.slice(0, CRITIC_FILE_SNIPPET_MAX) + `\n\n… [${s.length - CRITIC_FILE_SNIPPET_MAX} chars truncated]`;
}

export function buildCriticUserPrompt(seed: CriticSeed): string {
  const criterionBlock = seed.criterionDescription
    ? [
        "=== Parent criterion (what this todo is advancing) ===",
        `[${seed.criterionId ?? "?"}] ${seed.criterionDescription}`,
        "=== end criterion ===",
        "",
      ]
    : [];
  const filesBlock = seed.files
    .map((f) => {
      const header = f.before === null
        ? `--- ${f.file} (CREATED by this diff) ---`
        : `--- ${f.file} (MODIFIED by this diff) ---`;
      const before = f.before === null
        ? "(file did not exist before this diff)"
        : `=== BEFORE ===\n${snippet(f.before)}`;
      const after = `=== AFTER ===\n${snippet(f.after)}`;
      return [header, before, after, `--- end ${f.file} ---`].join("\n");
    })
    .join("\n\n");
  const recent =
    seed.recentCommits.length > 0
      ? seed.recentCommits
          .slice(0, CRITIC_RECENT_COMMITS_MAX)
          .map((c) => `- [${c.todoId}] ${c.description}  [files: ${c.files.join(", ") || "none"}]`)
          .join("\n")
      : "(no prior commits this run)";

  return [
    `Proposing agent: ${seed.proposingAgentId}`,
    "",
    ...criterionBlock,
    `=== Todo being committed ===`,
    `description: ${seed.todoDescription}`,
    `expectedFiles: ${seed.todoExpectedFiles.join(", ") || "(none)"}`,
    "=== end todo ===",
    "",
    "=== Recent prior commits this run (most recent first) ===",
    recent,
    "=== end recent commits ===",
    "",
    "=== Proposed change (per-file before + after) ===",
    filesBlock.length > 0 ? filesBlock : "(no files — should be rare)",
    "=== end proposed change ===",
    "",
    "Evaluate ONLY against the six patterns in the system prompt. Output the JSON verdict now.",
  ].join("\n");
}

// Repair prompt when the first response fails to parse. Same shape as the
// first-pass contract's repair: echo previous response + parser error, ask
// again for the right shape.
export function buildCriticRepairPrompt(previousResponse: string, parseError: string): string {
  return [
    "Your previous response could not be parsed as the required JSON object.",
    `Parser error: ${parseError}`,
    "",
    "Your previous response was:",
    "--- BEGIN PREVIOUS RESPONSE ---",
    previousResponse,
    "--- END PREVIOUS RESPONSE ---",
    "",
    "Respond now with ONLY a JSON object matching the schema:",
    '{"verdict": "accept" | "reject", "rationale": "one sentence (name which pattern if reject)"}',
    "",
    "No prose. No markdown fences. No commentary.",
  ].join("\n");
}
