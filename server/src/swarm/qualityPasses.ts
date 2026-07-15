// 2026-05-02 (quality levers #1 + #3): post-deliverable critic pass +
// next-action extraction. Both consume the deliverable just produced
// by writeXxxDeliverable; both return enhancements that the calling
// runner appends to the deliverable file before the system message
// announces it.
//
// LEVER #1 — CRITIC PASS:
//   A separate agent reads the deliverable + the rubric (from
//   rubricPrePass) and returns either {ok: true} or
//   {ok: false, weaknesses: [...]} naming specific gaps. Pure
//   diagnostic — does NOT auto-revise; the result lands in the
//   deliverable as a "Critic notes" section so the human reader
//   sees both the deliverable AND its weaknesses honestly. Avoids
//   the "swarm secretly revises until critic approves" pattern that
//   tends to collapse to bland uniformity.
//
// LEVER #3 — NEXT-ACTION EXTRACTION:
//   A pure parser walks the deliverable looking for actionable
//   recommendations + writes them as a structured "Next actions"
//   section. Pure parser, no LLM call — uses heuristics (lines
//   starting with action verbs, lines under "recommend"-shaped
//   headers, lines containing "should"/"need to"/"action:"). Lower
//   precision than an LLM-based extractor but free + deterministic;
//   if it's wrong, the worst case is a missing action, not a
//   hallucinated one.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractText } from "./extractText.js";
import { describeSdkError } from "./sdkError.js";
import type { DerivedRubric } from "./rubricPrePass.js";

// ---------------------------------------------------------------------
// LEVER #1 — Critic pass
// ---------------------------------------------------------------------

export interface CriticVerdict {
  /** True when the critic finds the deliverable solid. */
  approved: boolean;
  /** When approved===false, specific gaps the critic identified. */
  weaknesses: string[];
  /** Free-text rationale from the critic. */
  rationale: string;
  /** Raw response for diagnostics. */
  raw: string;
}

const DEFAULT_VERDICT: CriticVerdict = {
  approved: true,
  weaknesses: [],
  rationale: "(critic pass not run or failed silently)",
  raw: "",
};

const CRITIC_PROMPT_HEADER = [
  "You are a CRITIC reviewing a deliverable for the success rubric below. Your job is to find gaps — NOT to revise.",
  "",
  "Be honest. A deliverable that meets every criterion is rare; expect to flag 1-3 weaknesses on most reviews. Do NOT flag style preferences or minor wording — only substantive gaps.",
  "",
  "Output STRICT JSON only:",
  '  {"approved": <boolean>, "weaknesses": ["<gap 1>", "<gap 2>"], "rationale": "<one or two sentences>"}',
  "",
  "Rules:",
  "- approved=true means the deliverable substantially meets the rubric. weaknesses can still list nits, but the overall verdict is 'good enough to ship'.",
  "- approved=false means at least one criterion is materially unmet. weaknesses MUST name specific gaps (e.g. 'criterion 3 unmet — no file paths cited for the auth claim').",
  "- weaknesses are SPECIFIC. Not 'be more thorough' — name the section, claim, or criterion.",
  "- 0-5 weaknesses. Empty array is fine when approved.",
  "",
].join("\n");

/** Pure prompt builder — exported for tests. */
export function buildCriticPrompt(deliverable: string, rubric: DerivedRubric): string {
  const rubricLines = rubric.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    CRITIC_PROMPT_HEADER,
    `RUBRIC (${rubric.criteria.length} criteria):`,
    rubricLines,
    "",
    `DELIVERABLE SHAPE: ${rubric.deliverableShape}`,
    "",
    "DELIVERABLE TO REVIEW:",
    "--- BEGIN ---",
    deliverable.slice(0, 6000),
    "--- END ---",
    "",
    "Output JSON now:",
  ].join("\n");
}

/** Pure parser — exported for tests. Returns null on parse failure. */
export function parseCriticVerdict(raw: string): CriticVerdict | null {
  if (!raw || typeof raw !== "string") return null;
  let cleaned = raw.trim();
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
  const approved = parsed.approved === true || parsed.approved === false ? parsed.approved : null;
  if (approved === null) return null;
  const weaknesses = Array.isArray(parsed.weaknesses)
    ? parsed.weaknesses
        .filter((w: unknown): w is string => typeof w === "string" && w.trim().length > 0)
        .slice(0, 5)
    : [];
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim().slice(0, 500) : "";
  return { approved, weaknesses, rationale, raw };
}

/** Run the critic pass. Returns DEFAULT_VERDICT (approved=true, no
 *  weaknesses) on any failure so the calling runner can always
 *  proceed. */
export async function runCriticPass({
  agent,
  manager,
  deliverable,
  rubric,
}: {
  agent: Agent;
  manager: AgentManager;
  deliverable: string;
  rubric: DerivedRubric;
}): Promise<CriticVerdict> {
  if (deliverable.trim().length === 0) return DEFAULT_VERDICT;
  const prompt = buildCriticPrompt(deliverable, rubric);
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
    return parseCriticVerdict(raw) ?? DEFAULT_VERDICT;
  } catch {
    return DEFAULT_VERDICT;
  }
}

/** Render the critic verdict as a Markdown section. Pure — exported
 *  for tests. */
export function formatCriticMarkdown(verdict: CriticVerdict): string {
  const status = verdict.approved ? "✓ Approved" : "⚠ Weaknesses identified";
  const lines = [`**Status:** ${status}`, "", `**Rationale:** ${verdict.rationale || "(no rationale)"}`];
  if (verdict.weaknesses.length > 0) {
    lines.push("", "**Specific gaps:**");
    for (const w of verdict.weaknesses) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// LEVER #3 — Next-action extraction
// ---------------------------------------------------------------------

export interface NextAction {
  /** Rough priority bucket from the verb / context. */
  priority: "high" | "medium" | "low";
  /** The action text — usually one sentence. */
  text: string;
  /** Best-effort source: which section the action came from. */
  source?: string;
}

// Action verbs that strongly suggest "this is something to do".
// Phrased as line-prefix matches so we don't false-positive on
// occurrences inside narrative prose.
const HIGH_PRIORITY_VERBS = ["urgent", "must", "critical", "blocker", "block"];
const NORMAL_VERBS = [
  "add", "remove", "fix", "update", "refactor", "rename", "extract",
  "wire", "ship", "implement", "create", "delete", "migrate", "audit",
  "test", "document", "clean up", "consolidate", "split", "introduce",
];
const LOW_PRIORITY_VERBS = ["consider", "explore", "investigate", "evaluate", "research", "look into"];

const ACTION_HEADER_PATTERNS = [
  /^#+\s*(next|recommend|action|todo|todos|action items?)/i,
  /^#+\s*(suggested|recommended)/i,
];

/**
 * Normalize action text for dedup keys so re-ingesting the formatted
 * "Next actions" section (with `_(from: …)_` suffixes) does not double-count.
 * Also strips common JSON-field wrappers from council findings.
 */
export function normalizeNextActionKey(text: string): string {
  let t = text.trim();
  // Drop trailing source annotations from formatNextActionsMarkdown
  t = t.replace(/\s*_\(from:\s*[^)]+\)_\s*$/i, "");
  // Drop JSON field wrappers: "suggestion": "..." or suggestion: ...
  t = t.replace(/^["']?(?:suggestion|issue|recommendation|action)["']?\s*:\s*/i, "");
  // Strip surrounding quotes / escaped quotes
  t = t.replace(/^["']+|["']+$/g, "");
  t = t.replace(/\\"/g, '"').replace(/\\'/g, "'");
  // Collapse whitespace
  t = t.replace(/\s+/g, " ").trim();
  return t.toLowerCase();
}

/** Clean display text after extraction (without lowercasing). */
export function cleanNextActionText(text: string): string {
  let t = text.trim();
  t = t.replace(/\s*_\(from:\s*[^)]+\)_\s*$/i, "");
  t = t.replace(/^["']?(?:suggestion|issue|recommendation|action)["']?\s*:\s*/i, "");
  t = t.replace(/^["']+|["']+$/g, "");
  t = t.replace(/\\"/g, '"').replace(/\\'/g, "'");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** Pure extractor — exported for tests. Walks the deliverable
 *  markdown looking for action lines via heuristics:
 *    1. Lines under a "Next actions" / "Recommendations" header
 *    2. Bullet lines starting with action verbs anywhere
 *    3. Lines containing "should" / "need to" / "action:"
 *  Deduplicates by normalized key (strips source suffixes + JSON wrappers).
 *  Caps at 10 to keep the section readable. */
export function extractNextActions(deliverable: string): NextAction[] {
  if (!deliverable || deliverable.trim().length === 0) return [];
  const lines = deliverable.split(/\r?\n/);
  const actions: NextAction[] = [];
  const seen = new Set<string>();
  let currentSection: string | undefined;
  let inActionHeader = false;
  // Skip priority-bucket subheaders emitted by formatNextActionsMarkdown
  // so re-extraction of our own section stays clean.
  const priorityBucket = /^\*\*(high|medium|low)\s+priority:\*\*$/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (priorityBucket.test(line)) continue;
    // Section tracking via H2/H3.
    const headerMatch = line.match(/^#+\s+(.+)$/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim();
      inActionHeader = ACTION_HEADER_PATTERNS.some((p) => p.test(line));
      continue;
    }
    // Bullet-line check: "- thing", "* thing", "1. thing".
    const bulletMatch = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    const candidate = bulletMatch ? bulletMatch[1].trim() : null;
    let actionText: string | null = null;
    let priority: NextAction["priority"] = "medium";

    if (candidate) {
      const cleaned = cleanNextActionText(candidate);
      const lower = cleaned.toLowerCase();
      // Inside an action-shaped header: every bullet is an action.
      if (inActionHeader) {
        actionText = cleaned;
        priority = HIGH_PRIORITY_VERBS.some((v) => lower.startsWith(v))
          ? "high"
          : LOW_PRIORITY_VERBS.some((v) => lower.startsWith(v))
            ? "low"
            : "medium";
      }
      // Bullet starts with an action verb.
      else if (NORMAL_VERBS.some((v) => lower.startsWith(v + " "))) {
        actionText = cleaned;
        priority = "medium";
      } else if (HIGH_PRIORITY_VERBS.some((v) => lower.startsWith(v + " "))) {
        actionText = cleaned;
        priority = "high";
      } else if (LOW_PRIORITY_VERBS.some((v) => lower.startsWith(v + " "))) {
        actionText = cleaned;
        priority = "low";
      }
    } else if (!inActionHeader) {
      // Non-bullet line containing "should" or "need to" — extract
      // the sentence. Lower precision; only when not already in an
      // action header (otherwise headers' prose would dominate).
      const lower = line.toLowerCase();
      if (lower.includes("should ") || lower.includes("need to ") || lower.startsWith("action:")) {
        actionText = cleanNextActionText(line.replace(/^action:\s*/i, ""));
        priority = "medium";
      }
    }

    if (actionText && actionText.length >= 8 && actionText.length <= 300) {
      const key = normalizeNextActionKey(actionText);
      if (!seen.has(key) && key.length >= 8) {
        seen.add(key);
        actions.push({
          priority,
          text: actionText,
          ...(currentSection ? { source: currentSection } : {}),
        });
        if (actions.length >= 10) break;
      }
    }
  }

  // Sort: high → medium → low, preserving insertion order within each.
  const order = { high: 0, medium: 1, low: 2 };
  actions.sort((a, b) => order[a.priority] - order[b.priority]);
  return actions;
}

/** Render extracted actions as a Markdown section. Pure. */
export function formatNextActionsMarkdown(actions: readonly NextAction[]): string {
  if (actions.length === 0) {
    return "_(no actionable items detected — the deliverable may be analysis-only)_";
  }
  const buckets: Record<NextAction["priority"], NextAction[]> = { high: [], medium: [], low: [] };
  for (const a of actions) buckets[a.priority].push(a);
  const lines: string[] = [];
  for (const p of ["high", "medium", "low"] as const) {
    if (buckets[p].length === 0) continue;
    lines.push(`**${p.toUpperCase()} priority:**`);
    for (const a of buckets[p]) {
      lines.push(`- ${a.text}${a.source ? ` _(from: ${a.source})_` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
