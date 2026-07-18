/**
 * Worker skip taxonomy — pure classification, no prompts.
 *
 * Free-text `skip` from models mixes three populations (live 2010479c/120b2044):
 *   A) justified no-op ("already fixed…")
 *   B) exhausted-fail permanent skips (settlement-owned)
 *   C) garbage ("reason", "none") that should not settle as skip
 *
 * Keep agents capable: we do NOT ban real short reasons; we only reject
 * placeholder tokens and map clear phrases to codes for settlement/UI.
 */

export type WorkerSkipCode =
  | "already_done"
  | "out_of_scope"
  | "no_work"
  | "blocked"
  | "wont_do"
  | "other";

export type SkipClassifyResult =
  | { ok: true; code: WorkerSkipCode; reason: string; permanent: boolean }
  /** Placeholder / empty skip — treat as no-hunks retry, not a real skip. */
  | { ok: false; reason: "garbage_skip"; raw: string };

const GARBAGE = new Set([
  "reason",
  "none",
  "n/a",
  "na",
  "null",
  "undefined",
  "skip",
  "todo",
  "no",
  "yes",
  "-",
  "—",
  ".",
  "…",
  "...",
]);

/** True for placeholder skip strings models emit when they have no real rationale. */
export function isGarbageSkipReason(raw: string | undefined | null): boolean {
  if (raw == null) return true;
  const t = raw.trim().toLowerCase();
  if (!t) return true;
  if (GARBAGE.has(t)) return true;
  // Single generic token without substance
  if (/^(reason|none|n\/a|skip|todo)[\s.]*$/i.test(t)) return true;
  return false;
}

/**
 * Classify a worker skip string for settlement + UI.
 * Accepts optional `permanent:code` / `skipCode:` prefixes from structured emits.
 */
export function classifyWorkerSkip(raw: string | undefined | null): SkipClassifyResult {
  if (raw == null || isGarbageSkipReason(raw)) {
    return { ok: false, reason: "garbage_skip", raw: (raw ?? "").trim() };
  }
  const trimmed = raw.trim();

  // Structured: permanent:already-done: detail  OR  skipCode:already_done: detail
  const structured =
    /^(?:permanent|skipCode)\s*:\s*([a-z0-9_-]+)\s*(?::\s*(.*))?$/i.exec(trimmed);
  if (structured) {
    const code = normalizeSkipCode(structured[1]!);
    const detail = (structured[2] ?? "").trim() || trimmed;
    return {
      ok: true,
      code,
      reason: detail,
      permanent: isPermanentSkipCode(code),
    };
  }

  const lower = trimmed.toLowerCase();
  if (
    (/\balready\b/.test(lower)
      && /\b(present|done|exist|fixed|applied|in the file|no changes|verified)\b/.test(lower))
    || /\bno changes needed\b/.test(lower)
    || /\balready (?:fixed|done|applied|present)\b/.test(lower)
  ) {
    return { ok: true, code: "already_done", reason: trimmed, permanent: true };
  }
  if (/\bout of scope\b|\bnot (?:in|our) scope\b/.test(lower)) {
    return { ok: true, code: "out_of_scope", reason: trimmed, permanent: true };
  }
  if (/\bwont-?do\b|\bwon't do\b|\bwill not (?:do|implement)\b/.test(lower)) {
    return { ok: true, code: "wont_do", reason: trimmed, permanent: true };
  }
  if (
    /\bnot applicable\b|\bno todo\b|\bnothing to (?:do|change)\b|\bno work\b|\bempty (?:todo|task)\b/.test(
      lower,
    )
  ) {
    return { ok: true, code: "no_work", reason: trimmed, permanent: true };
  }
  if (/\bblocked\b|\bcannot\b|\bcan't\b|\binsufficient context\b|\bcontext only\b/.test(lower)) {
    // Soft: requeue / other agent may have better seed — not permanent by default
    return { ok: true, code: "blocked", reason: trimmed, permanent: false };
  }

  return { ok: true, code: "other", reason: trimmed, permanent: false };
}

function normalizeSkipCode(raw: string): WorkerSkipCode {
  const c = raw.toLowerCase().replace(/-/g, "_");
  if (c === "already_done" || c === "alreadydone") return "already_done";
  if (c === "out_of_scope" || c === "outofscope") return "out_of_scope";
  if (c === "no_work" || c === "nowork" || c === "not_applicable") return "no_work";
  if (c === "blocked") return "blocked";
  if (c === "wont_do" || c === "wontdo") return "wont_do";
  return "other";
}

function isPermanentSkipCode(code: WorkerSkipCode): boolean {
  return (
    code === "already_done"
    || code === "out_of_scope"
    || code === "no_work"
    || code === "wont_do"
  );
}

/**
 * Settlement helper: true when skip should not be requeued.
 * Combines structured codes with legacy permanent: prefix from settlement.
 */
export function isJustifiedPermanentSkip(reason: string | undefined): boolean {
  if (!reason) return false;
  if (/^permanent:/i.test(reason)) return true;
  const c = classifyWorkerSkip(reason);
  return c.ok && c.permanent;
}
