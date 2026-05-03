// 2026-05-02 (quality lever #2): rubric pre-pass.
//
// Before a discussion run starts, ask one agent to derive an explicit
// success rubric for the user's directive. The rubric is stored on
// the runner and (a) baked into the final deliverable as a "Success
// criteria" section, (b) consumed by the critic pass (lever #1) so
// the critic checks claims against the SAME rubric the swarm tried
// to hit, (c) consumed by the LLM-as-judge eval (#128) so scoring
// uses the per-run rubric instead of a generic one.
//
// Without this, every run optimizes against an implicit rubric the
// agents make up internally — different runs against the same
// directive land on different criteria. Pre-deriving + storing makes
// "what does done look like?" explicit upfront, which is what an
// editor or product reviewer does before evaluating a draft.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { extractText } from "./extractText.js";
import { describeSdkError } from "./sdkError.js";

export interface DerivedRubric {
  /** 3-6 dimensions the deliverable should score against. Short — each
   *  is a single sentence describing what "good" looks like. */
  criteria: string[];
  /** Free-text framing — what kind of deliverable this should be
   *  (analysis vs decision vs report vs walkthrough). Helps the
   *  critic pass distinguish "wrong shape" from "right shape but weak". */
  deliverableShape: string;
  /** Raw response for diagnostics — caller may persist if needed. */
  raw: string;
}

const DEFAULT_RUBRIC: DerivedRubric = {
  criteria: [
    "Addresses the directive directly without restating it",
    "Cites specific evidence from the codebase (file paths, symbols, or line ranges)",
    "Distinguishes verified claims from speculation",
    "Recommends a concrete next step",
  ],
  deliverableShape: "Concise analysis with sourced findings + a clear recommendation.",
  raw: "(default — pre-pass not run or failed)",
};

const PROMPT_HEADER = [
  "You are a rubric-deriver. Read the user's directive below and produce an explicit success rubric the team will optimize against.",
  "",
  "Output STRICT JSON only. No prose, no markdown fences. Shape:",
  '  {"deliverableShape": "<one sentence: what kind of artifact is this?>", "criteria": ["<dim 1>", "<dim 2>", ...]}',
  "",
  "Rules:",
  "- 3-6 criteria. Each ONE sentence describing what 'good' looks like.",
  "- Criteria must be SPECIFIC to the directive (not 'be clear' or 'be helpful').",
  "- deliverableShape names the artifact: 'audit list', 'architecture decision', 'coverage report', etc.",
  "- Do NOT include the rubric as a meta-criterion ('the rubric should...').",
  "",
  "Directive:",
].join("\n");

/** Pure prompt builder — exported for tests. */
export function buildRubricPrompt(directive: string): string {
  return `${PROMPT_HEADER}\n${directive.trim()}\n\nOutput JSON now:`;
}

/** Pure parser — exported for tests. Returns null on any parse failure;
 *  caller falls back to DEFAULT_RUBRIC. */
export function parseRubricResponse(raw: string): DerivedRubric | null {
  if (!raw || typeof raw !== "string") return null;
  let cleaned = raw.trim();
  // Strip ```json fences if present.
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  let parsed;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const criteria = Array.isArray(parsed.criteria)
    ? parsed.criteria.filter((c: unknown): c is string => typeof c === "string" && c.trim().length > 0)
    : [];
  const deliverableShape = typeof parsed.deliverableShape === "string" ? parsed.deliverableShape.trim() : "";
  if (criteria.length < 1 || criteria.length > 10) return null;
  if (!deliverableShape) return null;
  return { criteria, deliverableShape, raw };
}

/** Derive a rubric from the directive via one agent prompt. Returns
 *  DEFAULT_RUBRIC on any failure (network, parse, empty directive)
 *  so the calling runner can always proceed — the rubric is a quality
 *  enhancement, not a hard requirement. */
export async function deriveRubric({
  agent,
  manager,
  directive,
}: {
  agent: Agent;
  manager: AgentManager;
  directive: string | undefined;
}): Promise<DerivedRubric> {
  const trimmed = (directive ?? "").trim();
  if (trimmed.length === 0) return DEFAULT_RUBRIC;
  const prompt = buildRubricPrompt(trimmed);
  const ctrl = new AbortController();
  try {
    const res = (await promptWithRetry(agent, prompt, {
      signal: ctrl.signal,
      manager,
      formatExpect: "json",
      describeError: (e) => describeSdkError(e),
    })) as { data: { parts: Array<{ type: "text"; text: string }> } };
    const raw = extractText(res) ?? "";
    return parseRubricResponse(raw) ?? DEFAULT_RUBRIC;
  } catch {
    return DEFAULT_RUBRIC;
  }
}

/** 2026-05-02 (matrix row #1): recommend a proposer count from
 *  rubric complexity. Heuristic: each criterion needs ~1 proposer to
 *  cover (give or take); floor at 3 (MoA's structural minimum for
 *  diversity), cap at 6 (above which return diminishes vs latency).
 *  Pure — exported for tests. */
export function recommendProposerCount(rubric: DerivedRubric): number {
  const c = rubric.criteria.length;
  if (c <= 3) return 3;
  if (c >= 6) return 6;
  return c;
}

/** Render a rubric as a Markdown section the deliverable can include
 *  verbatim. Pure — exported for tests. */
export function formatRubricMarkdown(rubric: DerivedRubric): string {
  const lines = [`**Deliverable shape:** ${rubric.deliverableShape}`, "", "**Success criteria:**"];
  for (const c of rubric.criteria) {
    lines.push(`- ${c}`);
  }
  return lines.join("\n");
}
