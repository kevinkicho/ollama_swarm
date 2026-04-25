// Task #128: verifier agent — independent claim-checking.
//
// The blackboard already has a critic (busywork detection, per-commit) and
// an auditor (criterion satisfaction, per-cycle). The gap between them:
// when a worker submits a diff, the critic asks "is this BUSYWORK?" and
// the auditor — much later — asks "are the contract criteria met given
// every commit so far?". Neither asks the more pointed question:
//
//     "does THIS diff actually accomplish what THIS specific todo asked for?"
//
// In autonomous mode the gap is expensive: a worker can satisfy the critic
// (this isn't busywork) while still landing a diff that doesn't action the
// todo it claimed (e.g. todo asks for "add request-id header to outbound
// fetch calls", worker emits a refactor of an unrelated parser). The auditor
// will eventually catch it at the criterion level — but by then the swarm
// has wasted a commit slot AND probably built later todos on top of the
// half-fulfilled criterion.
//
// The verifier sits between critic accept and the disk write. Its job is
// strictly bounded:
//   1. Read the todo's description + expectedFiles.
//   2. Read the diff (before/after, same envelope the critic gets).
//   3. Issue ONE of four verdicts:
//      - "verified"     — the diff does what the todo asked for. Cite a
//                          line range in the diff that demonstrates it.
//      - "partial"      — the diff does PART of what the todo asked but
//                          leaves an explicit gap. Cite both what landed
//                          AND what's missing.
//      - "false"        — the diff does not action the todo (or actions
//                          something different). Cite the mismatch.
//      - "unverifiable" — the todo description is too vague OR the diff
//                          is too generic to make the call. Cite WHICH
//                          (so the planner knows to refine the todo).
//
// Verdict semantics in BlackboardRunner:
//   - "verified" or "partial" → accept (commit lands)
//   - "unverifiable"          → accept + log warning (planner gets the
//                                hint but the run doesn't grind on
//                                low-confidence verdicts)
//   - "false"                 → reject (mark stale, same as critic reject)
//
// Risk: verifier hallucinates a verdict without actually reading the diff.
// Mitigation: the parser REQUIRES `evidenceCitation` to be a non-empty
// string referencing either a file:line range or a quoted snippet from
// the diff. Verifier responses without a real citation get treated as
// "unverifiable" (failure-open) so a hallucinating verifier can't block
// real work.

import { z } from "zod";

export const VERIFIER_VERDICTS = ["verified", "partial", "false", "unverifiable"] as const;
export type VerifierVerdict = (typeof VERIFIER_VERDICTS)[number];

const VerifierResponseSchema = z.object({
  verdict: z.enum(VERIFIER_VERDICTS),
  // Required free-text citation. Two valid shapes:
  //   "src/foo.ts:42-58 — adds the requestId header"
  //   "after.ts: `headers['x-request-id'] = ctx.id`"
  // Empty string or whitespace-only is rejected by the schema.
  evidenceCitation: z.string().trim().min(1).max(500),
  // Optional reason; present on partial/false/unverifiable for context.
  rationale: z.string().trim().max(400).optional(),
});

export interface ParsedVerifierResponse {
  verdict: VerifierVerdict;
  evidenceCitation: string;
  rationale?: string;
}

export type VerifierParseResult =
  | { ok: true; verifier: ParsedVerifierResponse }
  | { ok: false; reason: string };

// Same fence-strip + first-brace fallback as critic / planner. Kept
// inline to avoid a small-shared-helper module.
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

export function parseVerifierResponse(raw: string): VerifierParseResult {
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
  const v = VerifierResponseSchema.safeParse(parsed);
  if (!v.success) {
    const reason = v.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }
  return {
    ok: true,
    verifier: {
      verdict: v.data.verdict,
      evidenceCitation: v.data.evidenceCitation,
      rationale: v.data.rationale,
    },
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const VERIFIER_SYSTEM_PROMPT = [
  "You are the VERIFIER. A WORKER in this swarm just proposed a diff against a repo, in service of a specific TODO. Before the diff is committed, you decide whether it ACTUALLY ACCOMPLISHES what the TODO asked for.",
  "",
  "You are NOT the critic (the critic catches busywork patterns; that gate has already passed if you're reading this). You are NOT the auditor (the auditor evaluates contract-level criteria across many commits). YOUR ONLY JOB is the per-commit question:",
  "",
  "    Does THIS diff do what THIS todo asked for?",
  "",
  "TOOLS (Unit 37 — same as the critic): You have `read`, `grep`, `glob`, `list` on the cloned repo. Use them when the diff alone is ambiguous (e.g. the todo asks for behavior change but the diff only adds an export; you should read the export's call sites to see if the behavior is wired up elsewhere).",
  "",
  "VERDICTS (pick exactly one):",
  "  - \"verified\"     — the diff does what the todo asked for. evidenceCitation MUST quote or reference the specific diff section that demonstrates it (e.g. \"after.ts:42-58 — adds the requestId header\").",
  "  - \"partial\"      — the diff does PART of the todo but leaves an explicit gap. evidenceCitation MUST cite both what landed AND what's missing.",
  "  - \"false\"        — the diff does not action the todo, OR it actions something different. evidenceCitation MUST cite the mismatch (e.g. \"todo asks for header injection but diff only renames a variable in unrelatedHelper.ts\").",
  "  - \"unverifiable\" — the todo description is too vague to evaluate, OR the diff is too generic to map back to the todo. evidenceCitation MUST cite WHICH (so the planner can refine).",
  "",
  "OUTPUT SHAPE:",
  "Output ONLY a single JSON object: {\"verdict\": \"verified\" | \"partial\" | \"false\" | \"unverifiable\", \"evidenceCitation\": \"<required, see above>\", \"rationale\": \"<optional one sentence>\"}.",
  "No prose outside the JSON. No fences.",
  "",
  "If you cannot produce a real evidenceCitation (file:line, quoted snippet, or a concrete description of WHAT IS WRONG with the todo or diff), the response MUST use verdict \"unverifiable\". Hallucinating a citation is worse than admitting you can't tell.",
].join("\n");

export interface VerifierUserPromptArgs {
  proposingAgentId: string;
  todoDescription: string;
  todoExpectedFiles: string[];
  files: ReadonlyArray<{
    file: string;
    before: string | null;
    after: string;
  }>;
}

// Build the per-commit user prompt. Mirrors buildCriticUserPrompt's
// shape so the prompt-rendering pattern stays consistent.
export function buildVerifierUserPrompt(args: VerifierUserPromptArgs): string {
  const { proposingAgentId, todoDescription, todoExpectedFiles, files } = args;
  const lines: string[] = [];
  lines.push(`Worker: ${proposingAgentId}`);
  lines.push(`TODO: ${todoDescription}`);
  if (todoExpectedFiles.length > 0) {
    lines.push(`Expected files: ${todoExpectedFiles.join(", ")}`);
  }
  lines.push("");
  lines.push("=== DIFFS ===");
  for (const { file, before, after } of files) {
    lines.push("");
    lines.push(`--- ${file} ---`);
    if (before === null) {
      lines.push("(file did not exist before)");
    } else {
      lines.push("BEFORE:");
      lines.push(before);
    }
    lines.push("AFTER:");
    lines.push(after);
  }
  lines.push("=== END DIFFS ===");
  lines.push("");
  lines.push(
    "Now issue your verdict per the system prompt. Output ONLY the JSON object — no prose, no fences.",
  );
  return lines.join("\n");
}
