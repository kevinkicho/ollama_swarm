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

export interface AgentJsonSummary {
  summary: string;
  json: string;
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
      return { summary: `Declined: ${truncate(p.skip, 160)}`, json: pretty };
    }
    if (p.hunks.length === 0) {
      return { summary: "Returned no changes", json: pretty };
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
    return { summary: `Wrote ${parts.join(", ")}`, json: pretty };
  }

  // Worker v1 (legacy): { diffs: [...], skip?: string }. Kept so replays of
  // pre-Unit-1 event logs still render cleanly. Current workers emit hunks.
  if (isObject(parsed) && Array.isArray((parsed as { diffs?: unknown }).diffs)) {
    const p = parsed as { diffs: unknown[]; skip?: unknown };
    if (typeof p.skip === "string" && p.skip.trim().length > 0) {
      return { summary: `Declined: ${truncate(p.skip, 160)}`, json: pretty };
    }
    if (p.diffs.length === 0) {
      return { summary: "Returned no changes", json: pretty };
    }
    const parts = p.diffs.map((d) => {
      if (isObject(d) && typeof d.file === "string" && typeof d.newText === "string") {
        return `${d.file} (${d.newText.length.toLocaleString()} chars)`;
      }
      return "[malformed diff]";
    });
    return { summary: `Wrote ${parts.join(", ")}`, json: pretty };
  }

  // Replanner revise: { revised: { description, expectedFiles } }
  if (isObject(parsed) && isObject((parsed as { revised?: unknown }).revised)) {
    const r = (parsed as { revised: { description?: unknown; expectedFiles?: unknown } }).revised;
    const desc = typeof r.description === "string" ? r.description : "(no description)";
    const files = Array.isArray(r.expectedFiles)
      ? r.expectedFiles.filter((f): f is string => typeof f === "string")
      : [];
    const filesSuffix = files.length > 0 ? ` → ${files.join(", ")}` : "";
    return { summary: `Revised: ${truncate(desc, 120)}${filesSuffix}`, json: pretty };
  }

  // Replanner skip: { skip: true, reason: string }
  if (isObject(parsed) && (parsed as { skip?: unknown }).skip === true) {
    const p = parsed as { reason?: unknown };
    const reason = typeof p.reason === "string" ? p.reason : "(no reason)";
    return { summary: `Skipped: ${truncate(reason, 160)}`, json: pretty };
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
    return {
      summary: `Contract: ${truncate(p.missionStatement, 120)}\n${critBlock}`,
      json: pretty,
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
    return { summary: `Audit: ${counts}${newSuffix}`, json: pretty };
  }

  // Planner: top-level array of { description, expectedFiles }
  if (Array.isArray(parsed) && parsed.length > 0) {
    const looksLikeTodos = parsed.every(
      (t) => isObject(t) && typeof (t as { description?: unknown }).description === "string",
    );
    if (looksLikeTodos) {
      const first = (parsed[0] as { description: string }).description;
      const more = parsed.length > 1 ? ` (+${parsed.length - 1} more)` : "";
      return {
        summary: `Posted ${parsed.length} todo${parsed.length === 1 ? "" : "s"}: ${truncate(first, 100)}${more}`,
        json: pretty,
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
