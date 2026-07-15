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
import { extractJsonFromText as stripFences } from "../../extractJson.js";
import { lenientPreprocess } from "./lenientParse.js";
import { JSON_ONLY_FINAL_RULE_LINES } from "./sharedSnippets.js";

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

export function parseCriticResponse(raw: string): CriticParseResult {
  if (raw.trim().length === 0) {
    return { ok: false, reason: "empty response — model produced no output after stripping thinking tags" };
  }
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
  const processed = lenientPreprocess(parsed, {
    maxRationale: 400,
  });
  const v = CriticResponseSchema.safeParse(processed);
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
  "You are the CRITIC: accept substantive work, reject busywork before commit.",
  "TOOLS: read, grep, glob, list — ground verdicts in the repo when judging duplicates/regressions.",
  "Reject if any of: (1) duplicate content, (2) tests without behavior, (3) rename/reorg only, (4) stubs, (5) generic filler docs, (6) regressions removing real coverage.",
  "Accept if a maintainer would keep the change. Ignore style/bikeshed/better-approach debates.",
  ...JSON_ONLY_FINAL_RULE_LINES,
  "Shape: {\"verdict\":\"accept\"|\"reject\",\"rationale\":\"ONE sentence naming the pattern or the concrete add\"}.",
].join("\n");

// Unit 60: regression critic — narrower lens than the substance
// critic. Looks specifically at "could this break something that was
// working." The substance critic catches BUSYWORK; this critic
// catches REGRESSIONS that look superficially substantive but quietly
// break the contract elsewhere.
export const REGRESSION_CRITIC_NAME = "regression";

export const REGRESSION_CRITIC_SYSTEM_PROMPT = [
  "You are the REGRESSION CRITIC: flag diffs that may BREAK SOMETHING THAT CURRENTLY WORKS.",
  "TOOLS: read, grep, glob, list — check callers, dropped guards, tests, config keys, import rewires.",
  "Reject on: R1 CALLER BREAKAGE, R2 REMOVED INVARIANT, R3 silent contract flip, R4 TEST DELETION or weakening, R5 config/schema break, R6 path/export rewire without import updates.",
  "Accept if purely additive or safely contained. Ignore substance and style.",
  ...JSON_ONLY_FINAL_RULE_LINES,
  "Shape: {\"verdict\":\"accept\"|\"reject\",\"rationale\":\"ONE sentence with pattern + cite\"}.",
].join("\n");

// Unit 60: consistency critic — orthogonal to the other two. Looks
// at codebase fit. Catches diffs that are technically correct AND
// safe but feel like they were written by someone who didn't read
// the rest of the project.
export const CONSISTENCY_CRITIC_NAME = "consistency";

export const CONSISTENCY_CRITIC_SYSTEM_PROMPT = [
  "You are the CONSISTENCY CRITIC: reject diffs that DOESN'T MATCH the rest of the codebase.",
  "TOOLS: read, grep, glob, list — sample siblings for naming, style, helpers, abstractions.",
  "Reject on: C1 NAMING DRIFT, C2 DUPLICATE UTILITY, C3 clear style mismatch, C4 antipattern vs local convention, C5 BYPASSED ABSTRACTION.",
  "Accept if it fits nearby code. Ignore substance; do not re-check call-site safety.",
  ...JSON_ONLY_FINAL_RULE_LINES,
  "Shape: {\"verdict\":\"accept\"|\"reject\",\"rationale\":\"ONE sentence with pattern + contrast\"}.",
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
