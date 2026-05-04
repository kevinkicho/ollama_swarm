// 2026-05-03 (debate-judge improvement #1): convert a user directive
// into a sharp PRO/CON proposition. The judge agent runs a one-shot
// pass at run start; if it returns a usable proposition, the debate
// uses it. On any failure (empty directive, network, parse) we fall
// back to a pure pass-through proposition `"We should pursue: <X>"`,
// which produces a more lopsided debate but never crashes the run.
//
// Sister to rubricPrePass.ts — same shape (one agent prompt, JSON
// output, lenient fallback).

import type { Agent, AgentManager } from "../services/AgentManager.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractText } from "./extractText.js";
import { describeSdkError } from "./sdkError.js";

/** The judge agent's expected output shape. Lenient parser accepts
 *  any JSON with a `proposition` string; the optional `rationale` is
 *  surfaced in the seed for transparency about why this was chosen. */
export interface DerivedProposition {
  /** The PRO/CON proposition the debate will run on. Must be a sharp
   *  claim that admits real disagreement — not a strawman or restatement
   *  of the directive. */
  proposition: string;
  /** Optional one-line explanation of why this proposition was chosen.
   *  Empty when the auto-derive failed and we fell back to pass-through. */
  rationale: string;
  /** True when the proposition came from the LLM auto-derive; false
   *  when it's the pass-through fallback. Used by the seed to label
   *  the source so the human reader knows what they're getting. */
  derived: boolean;
}

/** Pure builder — exported for tests. The prompt explicitly asks for a
 *  claim that admits real disagreement to avoid strawmen, and gives
 *  a worked example so the model has something concrete to mirror. */
export function buildPropositionDerivationPrompt(directive: string): string {
  return [
    "You are picking the proposition for a structured PRO vs CON debate.",
    "",
    "=== USER DIRECTIVE ===",
    directive,
    "=== END DIRECTIVE ===",
    "",
    "The directive above is the broader work. Your job: convert it into a sharp **debatable proposition** — a claim about HOW to pursue the directive that has real grounds for disagreement.",
    "",
    "Rules for a good proposition:",
    "1. It must be a SINGLE declarative claim (not a question, not a list).",
    "2. It must be specific enough that PRO and CON can argue concretely (not vague restatements like 'we should be careful').",
    "3. It must admit REAL disagreement — a thoughtful engineer should be able to argue either side. Avoid strawmen where one side has no foothold.",
    "4. It should be ONE level of contention below the directive — i.e. given the directive is happening, the proposition is about HOW or WHEN or AT-WHAT-COST.",
    "",
    "Worked example:",
    "  Directive: \"Refactor the auth module to use bcrypt instead of MD5.\"",
    "  Good proposition: \"We should land the bcrypt migration as a single big-bang PR rather than incremental file-by-file rollouts.\"",
    "  Bad proposition (strawman): \"We should use bcrypt.\" (PRO has no opposition.)",
    "  Bad proposition (vague): \"We should be careful about auth changes.\" (Nothing specific to argue.)",
    "",
    "Output ONLY a JSON object (no prose, no fences):",
    '{"proposition": "<the sharp claim>", "rationale": "<one sentence — why this is the most useful angle to debate>"}',
  ].join("\n");
}

/** Lenient JSON parser. Tolerates ```json fences and the model
 *  prefacing the object with prose. Returns null when no usable
 *  `proposition` string can be extracted. */
export function parseDerivedProposition(raw: string): DerivedProposition | null {
  if (!raw || raw.trim().length === 0) return null;
  // Strip a ```json ... ``` fence if present.
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m.exec(raw.trim());
  const candidate = fenced ? fenced[1] : raw;
  // Slice the first {...} object out, in case the model emitted prose around it.
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  const slice = candidate.slice(firstBrace, lastBrace + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const prop = typeof o.proposition === "string" ? o.proposition.trim() : "";
  if (prop.length === 0) return null;
  const rat = typeof o.rationale === "string" ? o.rationale.trim() : "";
  return { proposition: prop, rationale: rat, derived: true };
}

/** Pass-through fallback when the LLM derivation fails. Produces a
 *  syntactically-valid proposition the debate runner can use, even
 *  though the resulting debate will be more lopsided (PRO just
 *  restates the directive). Marked `derived: false` so the seed can
 *  label the source. */
export function fallbackProposition(directive: string): DerivedProposition {
  return {
    proposition: `We should pursue: ${directive.trim()}`,
    rationale: "(auto-derivation failed — using pass-through proposition; debate may be lopsided)",
    derived: false,
  };
}

/** Run the auto-derivation. Always returns a usable proposition, even
 *  on every failure mode — the debate never blocks on this. Mirrors
 *  rubricPrePass.deriveRubric's "best-effort with safe fallback" shape. */
export async function deriveProposition({
  agent,
  manager,
  directive,
}: {
  agent: Agent;
  manager: AgentManager;
  directive: string | undefined;
}): Promise<DerivedProposition | null> {
  const trimmed = (directive ?? "").trim();
  if (trimmed.length === 0) return null;
  const prompt = buildPropositionDerivationPrompt(trimmed);
  const ctrl = new AbortController();
  try {
    // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
    const res = (await promptWithFailoverAuto(agent, prompt, {
      signal: ctrl.signal,
      manager,
      formatExpect: "json",
      describeError: (e) => describeSdkError(e),
    })) as { data: { parts: Array<{ type: "text"; text: string }> } };
    const raw = extractText(res) ?? "";
    const parsed = parseDerivedProposition(raw);
    return parsed ?? fallbackProposition(trimmed);
  } catch {
    return fallbackProposition(trimmed);
  }
}
