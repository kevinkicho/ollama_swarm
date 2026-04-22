// Recognizes blackboard-preset agent response JSON (planner array / worker
// {diffs} / replanner {revised | skip} / first-pass contract / auditor) and
// produces a one-line summary plus pretty-printed JSON for reveal. Returns
// null when the text isn't a recognized shape — the caller falls back to
// rendering raw text.
//
// The shape constants MUST stay in sync with the server-side zod schemas in
// server/src/swarm/blackboard/prompts/{planner,worker,replanner,firstPassContract,auditor}.ts.
// Keep the reference doc (docs/blackboard-response-schemas.md) in lockstep too.

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

  // Worker: { diffs: [...], skip?: string }
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
    const firstDesc = n > 0 && isObject(p.criteria[0]) && typeof p.criteria[0].description === "string"
      ? p.criteria[0].description
      : null;
    const crit = n === 0
      ? "0 criteria"
      : `${n} criteri${n === 1 ? "on" : "a"}${firstDesc ? `: ${truncate(firstDesc, 90)}` : ""}`;
    return {
      summary: `Contract: ${truncate(p.missionStatement, 120)} — ${crit}`,
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
  if (fence) return fence[1].trim();
  // Top-level JSON starts at character 0.
  if (s.startsWith("{") || s.startsWith("[")) return s;
  // Prose-then-JSON: slice from the first '{' or '[' to the last matching
  // delimiter. Lenient — if it doesn't parse, caller falls back anyway.
  const firstBrace = s.indexOf("{");
  const firstBracket = s.indexOf("[");
  const first =
    firstBrace < 0
      ? firstBracket
      : firstBracket < 0
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  if (first <= 0) return null;
  const closer = s[first] === "{" ? "}" : "]";
  const last = s.lastIndexOf(closer);
  if (last <= first) return null;
  return s.slice(first, last + 1);
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
