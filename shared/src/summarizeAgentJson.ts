// V2 Step 2c: shared agent-response summarizer. Recognizes blackboard-
// preset envelope shapes (worker hunks, replanner revise/skip, planner
// contract, auditor verdicts, planner todo-array) and produces a one-line
// summary plus pretty-printed JSON for the bubble's reveal panel.
//
// Returns null when the text isn't a recognized shape — the caller falls
// back to rendering raw text via CollapsibleBlock.
//
// Previously: web/src/components/transcriptSummarize.ts (web-only).
// Server had its own per-prompt zod parsers in
// server/src/swarm/blackboard/prompts/*.ts that produced separate
// summary text via formatServerSummary. Both paths recognized the same
// envelopes; consolidating here means new envelope kinds get one
// summary implementation visible to both sides.

import { extractFirstBalancedJson } from "./extractJson.js";

// Phase 3 (UI coherent-fix package, 2026-04-27): structured parse
// result returned alongside the summary string so the web side can
// route to a kind-specific expandable bubble (ContractBubble,
// AuditorVerdictBubble) instead of dropping straight to raw-JSON
// view when the user clicks "VIEW JSON". The summary string is
// preserved exactly as before for back-compat with existing
// AgentJsonBubble rendering. `kind: "unknown"` means we recognized
// the shape enough to summarize but the web doesn't have a dedicated
// component for it yet (worker_hunks, replanner — those still
// route to existing bubbles via different detectors).
export type ParsedEnvelope =
  | {
      kind: "contract";
      missionStatement: string;
      criteria: Array<{ description: string; expectedFiles: string[] }>;
    }
  | {
      kind: "auditor";
      verdicts: Array<{
        id: string;
        status: string;
        rationale: string;
        todos?: unknown[];
      }>;
      newCriteria?: Array<{ description: string; expectedFiles: string[] }>;
    }
  | { kind: "todos"; todos: Array<{ description: string; expectedFiles: string[] }> }
  | { kind: "unknown" };

export interface AgentJsonSummary {
  summary: string;
  json: string;
  // Phase 3 (2026-04-27): always populated; defaults to {kind:"unknown"}
  // for envelope shapes the summarizer recognized but the web doesn't
  // have a dedicated bubble for. Web's MessageBubble routes on
  // parsed.kind to choose between ContractBubble / AuditorVerdictBubble
  // / AgentJsonBubble fallback.
  parsed: ParsedEnvelope;
}

export function summarizeAgentJson(raw: string): AgentJsonSummary | null {
  const extracted = extractJson(raw);
  if (!extracted) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch {
    return null;
  }

  const pretty = safePretty(parsed);

  // Worker v2: { hunks: [ replace | create | append ], skip?: string }. Must
  // be checked BEFORE the v1 diffs branch — a malformed response could in
  // principle have both keys, but worker.ts only emits hunks now.
  if (isObject(parsed) && Array.isArray((parsed as { hunks?: unknown }).hunks)) {
    const p = parsed as { hunks: unknown[]; skip?: unknown };
    if (typeof p.skip === "string" && p.skip.trim().length > 0) {
      return { summary: `Declined: ${truncate(p.skip, 160)}`, json: pretty, parsed: { kind: "unknown" } };
    }
    if (p.hunks.length === 0) {
      return { summary: "Returned no changes", json: pretty, parsed: { kind: "unknown" } };
    }
    const parts = p.hunks.map((h) => {
      if (!isObject(h) || typeof h.file !== "string") return "[malformed hunk]";
      const file = h.file;
      if (h.op === "create" && typeof h.content === "string") {
        return `create ${file} (${h.content.length.toLocaleString()} chars)`;
      }
      if (h.op === "replace" && typeof h.search === "string" && typeof h.replace === "string") {
        const delta = h.replace.length - h.search.length;
        const sign = delta > 0 ? "+" : "";
        return `replace ${file} (${sign}${delta.toLocaleString()} chars)`;
      }
      if (h.op === "append" && typeof h.content === "string") {
        return `append ${file} (+${h.content.length.toLocaleString()} chars)`;
      }
      return `[unknown hunk on ${file}]`;
    });
    return { summary: `Wrote ${parts.join(", ")}`, json: pretty, parsed: { kind: "unknown" } };
  }

  // Worker v1 (legacy): { diffs: [...], skip?: string }. Kept so replays of
  // pre-Unit-1 event logs still render cleanly. Current workers emit hunks.
  if (isObject(parsed) && Array.isArray((parsed as { diffs?: unknown }).diffs)) {
    const p = parsed as { diffs: unknown[]; skip?: unknown };
    if (typeof p.skip === "string" && p.skip.trim().length > 0) {
      return { summary: `Declined: ${truncate(p.skip, 160)}`, json: pretty, parsed: { kind: "unknown" } };
    }
    if (p.diffs.length === 0) {
      return { summary: "Returned no changes", json: pretty, parsed: { kind: "unknown" } };
    }
    const parts = p.diffs.map((d) => {
      if (isObject(d) && typeof d.file === "string" && typeof d.newText === "string") {
        return `${d.file} (${d.newText.length.toLocaleString()} chars)`;
      }
      return "[malformed diff]";
    });
    return { summary: `Wrote ${parts.join(", ")}`, json: pretty, parsed: { kind: "unknown" } };
  }

  // Replanner revise: { revised: { description, expectedFiles } }
  if (isObject(parsed) && isObject((parsed as { revised?: unknown }).revised)) {
    const r = (parsed as { revised: { description?: unknown; expectedFiles?: unknown } }).revised;
    const desc = typeof r.description === "string" ? r.description : "(no description)";
    const files = Array.isArray(r.expectedFiles)
      ? r.expectedFiles.filter((f): f is string => typeof f === "string")
      : [];
    const filesSuffix = files.length > 0 ? ` → ${files.join(", ")}` : "";
    return { summary: `Revised: ${truncate(desc, 120)}${filesSuffix}`, json: pretty, parsed: { kind: "unknown" } };
  }

  // Replanner skip: { skip: true, reason: string }
  if (isObject(parsed) && (parsed as { skip?: unknown }).skip === true) {
    const p = parsed as { reason?: unknown };
    const reason = typeof p.reason === "string" ? p.reason : "(no reason)";
    return { summary: `Skipped: ${truncate(reason, 160)}`, json: pretty, parsed: { kind: "unknown" } };
  }

  // First-pass contract: { missionStatement: string, criteria: [{description, expectedFiles}] }
  if (
    isObject(parsed) &&
    typeof (parsed as { missionStatement?: unknown }).missionStatement === "string" &&
    Array.isArray((parsed as { criteria?: unknown }).criteria)
  ) {
    const p = parsed as { missionStatement: string; criteria: unknown[] };
    const n = p.criteria.length;
    // 2026-04-26 fix: show first 3 criteria descriptions instead of just
    // first 1. Per-criterion truncated to 90 chars; suffix "+N more" if
    // longer. Still bounded at ~400 chars total but conveys structure
    // instead of "Contract: blah — 7 criteria: blah" hiding 6 unseen.
    const previewCount = Math.min(3, n);
    const previewLines: string[] = [];
    for (let i = 0; i < previewCount; i++) {
      const c = p.criteria[i];
      if (!isObject(c) || typeof c.description !== "string") continue;
      previewLines.push(`  ${i + 1}. ${truncate(c.description, 90)}`);
    }
    const moreSuffix = n > previewCount ? `\n  …+${n - previewCount} more` : "";
    const critBlock = n === 0
      ? "0 criteria"
      : `${n} criteri${n === 1 ? "on" : "a"}:\n${previewLines.join("\n")}${moreSuffix}`;
    // Phase 3 (2026-04-27): also return the structured criteria so
    // ContractBubble can render the full list with an interactive
    // expand instead of the stringified preview.
    const criteriaForUi: Array<{ description: string; expectedFiles: string[] }> = [];
    for (const c of p.criteria) {
      if (!isObject(c)) continue;
      const desc = typeof c.description === "string" ? c.description : "";
      const files = Array.isArray(c.expectedFiles)
        ? c.expectedFiles.filter((f): f is string => typeof f === "string")
        : [];
      if (desc) criteriaForUi.push({ description: desc, expectedFiles: files });
    }
    return {
      summary: `Contract: ${truncate(p.missionStatement, 120)}\n${critBlock}`,
      json: pretty,
      parsed: {
        kind: "contract",
        missionStatement: p.missionStatement,
        criteria: criteriaForUi,
      },
    };
  }

  // Auditor: { verdicts: [{id, status, rationale, todos?}], newCriteria?: [...] }
  if (isObject(parsed) && Array.isArray((parsed as { verdicts?: unknown }).verdicts)) {
    const p = parsed as { verdicts: unknown[]; newCriteria?: unknown };
    let met = 0;
    let wontDo = 0;
    let unmet = 0;
    let unknown = 0;
    for (const v of p.verdicts) {
      if (!isObject(v)) { unknown++; continue; }
      const status = (v as { status?: unknown }).status;
      if (status === "met") met++;
      else if (status === "wont-do") wontDo++;
      else if (status === "unmet") unmet++;
      else unknown++;
    }
    const newN = Array.isArray(p.newCriteria) ? p.newCriteria.length : 0;
    const counts = [
      met ? `${met} met` : null,
      wontDo ? `${wontDo} wont-do` : null,
      unmet ? `${unmet} unmet` : null,
      unknown ? `${unknown} ?` : null,
    ].filter(Boolean).join(", ") || "0 verdicts";
    const newSuffix = newN > 0 ? ` (+${newN} new criteri${newN === 1 ? "on" : "a"})` : "";
    // Phase 3 (2026-04-27): also return the structured verdicts so
    // AuditorVerdictBubble can render the full list with rationale +
    // interactive expand.
    const verdictsForUi: Array<{ id: string; status: string; rationale: string; todos?: unknown[] }> = [];
    for (const v of p.verdicts) {
      if (!isObject(v)) continue;
      const id = typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : "";
      const status = typeof (v as { status?: unknown }).status === "string"
        ? (v as { status: string }).status
        : "unknown";
      const rationale = typeof (v as { rationale?: unknown }).rationale === "string"
        ? (v as { rationale: string }).rationale
        : "";
      const todos = Array.isArray((v as { todos?: unknown }).todos)
        ? (v as { todos: unknown[] }).todos
        : undefined;
      if (id) verdictsForUi.push({ id, status, rationale, todos });
    }
    const newCriteriaForUi: Array<{ description: string; expectedFiles: string[] }> = [];
    if (Array.isArray(p.newCriteria)) {
      for (const c of p.newCriteria) {
        if (!isObject(c)) continue;
        const desc = typeof c.description === "string" ? c.description : "";
        const files = Array.isArray(c.expectedFiles)
          ? c.expectedFiles.filter((f): f is string => typeof f === "string")
          : [];
        if (desc) newCriteriaForUi.push({ description: desc, expectedFiles: files });
      }
    }
    return {
      summary: `Audit: ${counts}${newSuffix}`,
      json: pretty,
      parsed: {
        kind: "auditor",
        verdicts: verdictsForUi,
        ...(newCriteriaForUi.length > 0 ? { newCriteria: newCriteriaForUi } : {}),
      },
    };
  }

  // Planner: top-level array of { description, expectedFiles }
  if (Array.isArray(parsed) && parsed.length > 0) {
    const looksLikeTodos = parsed.every(
      (t) => isObject(t) && typeof (t as { description?: unknown }).description === "string",
    );
    if (looksLikeTodos) {
      const first = (parsed[0] as { description: string }).description;
      const more = parsed.length > 1 ? ` (+${parsed.length - 1} more)` : "";
      // Phase 3 (2026-04-27): also return structured todos.
      const todosForUi: Array<{ description: string; expectedFiles: string[] }> = [];
      for (const t of parsed) {
        if (!isObject(t)) continue;
        const desc = typeof (t as { description?: unknown }).description === "string"
          ? (t as { description: string }).description
          : "";
        const files = Array.isArray((t as { expectedFiles?: unknown }).expectedFiles)
          ? (t as { expectedFiles: unknown[] }).expectedFiles.filter((f): f is string => typeof f === "string")
          : [];
        if (desc) todosForUi.push({ description: desc, expectedFiles: files });
      }
      return {
        summary: `Posted ${parsed.length} todo${parsed.length === 1 ? "" : "s"}: ${truncate(first, 100)}${more}`,
        json: pretty,
        parsed: { kind: "todos", todos: todosForUi },
      };
    }
  }

  return null;
}

function extractJson(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // Fenced block first — ```json ... ``` or bare ``` ... ```.
  const fence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fence) {
    const inner = fence[1].trim();
    return extractFirstBalancedJson(inner) ?? inner;
  }
  // Top-level JSON: prefer the first balanced object/array even when
  // it starts at character 0 — handles models that hallucinate
  // chat-template continuation after the real response (gemma4 in run
  // b6d91d13 produced 17KB of fake "next prompt" cycles after a valid
  // response). The balanced extractor stops at the matching close.
  return extractFirstBalancedJson(s);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

function safePretty(parsed: unknown): string {
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(parsed);
  }
}
