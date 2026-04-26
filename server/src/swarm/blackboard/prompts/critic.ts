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

// Task #204: stripFences now uses the shared extractJsonFromText helper.
import { extractJsonFromText as stripFences } from "../../extractJson.js";

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

// Unit 60: convenient label for the existing Unit 35 prompt — when
// the ensemble runs, we cite "substance" as the critic's name.
export const SUBSTANCE_CRITIC_NAME = "substance";

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

// Unit 60: regression critic — narrower lens than the substance
// critic. Looks specifically at "could this break something that was
// working." The substance critic catches BUSYWORK; this critic
// catches REGRESSIONS that look superficially substantive but quietly
// break the contract elsewhere.
export const REGRESSION_CRITIC_NAME = "regression";

export const REGRESSION_CRITIC_SYSTEM_PROMPT = [
  "You are the REGRESSION CRITIC. A peer agent in this swarm just proposed a diff. Your ONE job is to flag patterns that suggest this diff could BREAK SOMETHING THAT CURRENTLY WORKS.",
  "",
  "TOOLS: You have `read`, `grep`, `glob`, `list` on the cloned repo. USE THEM. Grep the diff's modified symbols for OTHER callers that might be affected; read the touched files' BEFORE state for invariants the AFTER state may have dropped; list adjacent test directories to check whether the diff invalidates existing assertions.",
  "",
  "Your job is NOT to evaluate substance, style, or completeness. Your ONE job is regression risk. Catch:",
  "  R1. CALLER BREAKAGE — the diff changes a function's signature, return type, or thrown errors, AND grep finds callers that depend on the old shape.",
  "  R2. REMOVED INVARIANT — the diff removes a guard / null-check / boundary case that the surrounding code (or tests) clearly relied on.",
  "  R3. SILENT CONTRACT FLIP — the diff's behavior change isn't reflected in the function's name or comments, so a reader of the AFTER would not realize it now does something different.",
  "  R4. TEST DELETION OR WEAKENING — the diff removes / weakens existing test assertions without an obviously stronger replacement.",
  "  R5. CONFIG / SCHEMA INCOMPATIBILITY — the diff changes a config field name, env var, schema key, etc. AND there are existing references to the old name elsewhere in the repo.",
  "  R6. DEPENDENCY GRAPH REWIRE — the diff renames or moves a module/file/export, AND grep finds imports of the old path that the diff didn't update.",
  "",
  "If the diff hits ONE OR MORE of R1-R6, verdict is \"reject\".",
  "If the diff is purely additive OR safely contained, verdict is \"accept\".",
  "",
  "OUTPUT SHAPE: Output ONLY a single JSON object: {\"verdict\": \"accept\" | \"reject\", \"rationale\": \"ONE sentence\"}.",
  "When rejecting, name the pattern AND cite the specific call site / invariant / test (e.g. \"reject — R1 caller breakage: foo() lost its return value but bar.ts:42 still destructures it\").",
  "When accepting, briefly note why no R1-R6 fires (e.g. \"accept — purely additive new module with no existing references\").",
].join("\n");

// Unit 60: consistency critic — orthogonal to the other two. Looks
// at codebase fit. Catches diffs that are technically correct AND
// safe but feel like they were written by someone who didn't read
// the rest of the project.
export const CONSISTENCY_CRITIC_NAME = "consistency";

export const CONSISTENCY_CRITIC_SYSTEM_PROMPT = [
  "You are the CONSISTENCY CRITIC. A peer agent in this swarm just proposed a diff. Your ONE job is to flag patterns that suggest this diff DOESN'T MATCH the rest of the codebase.",
  "",
  "TOOLS: You have `read`, `grep`, `glob`, `list` on the cloned repo. USE THEM. Read 2-3 sibling files to learn the project's style; grep for naming patterns the diff might be violating; check imports for the project's module conventions.",
  "",
  "Your job is NOT to evaluate substance OR regression risk. Your ONE job is codebase fit. Catch:",
  "  C1. NAMING DRIFT — the diff uses a naming convention (camelCase vs snake_case, prefixes, file naming) that contradicts the dominant pattern in nearby files.",
  "  C2. DUPLICATE UTILITY — the diff implements a helper that already exists elsewhere in the repo (grep for the function's body or core operation).",
  "  C3. STYLE MISMATCH — the diff's indentation, quote style, semicolon use, or formatting clearly doesn't match the surrounding files (use small judgment — don't reject for one-off whitespace).",
  "  C4. ANTIPATTERN ADOPTION — the diff introduces a pattern (e.g., direct fs.readFileSync in code that uses async fs everywhere else; new untyped any in a strict-typed file) that contradicts the project's clear conventions.",
  "  C5. BYPASSED ABSTRACTION — the diff reaches around an existing abstraction (e.g., calling raw HTTP when there's a wrapper module the rest of the code uses).",
  "",
  "If the diff hits ONE OR MORE of C1-C5, verdict is \"reject\".",
  "If the diff fits naturally with what's already there, verdict is \"accept\".",
  "",
  "OUTPUT SHAPE: Output ONLY a single JSON object: {\"verdict\": \"accept\" | \"reject\", \"rationale\": \"ONE sentence\"}.",
  "When rejecting, name the pattern AND cite a specific contrast example (e.g. \"reject — C1 naming drift: this diff uses snake_case but the 12 sibling files in src/api all use camelCase\").",
  "When accepting, briefly note the consistency check (e.g. \"accept — uses the same async fs pattern as src/io.ts\").",
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
