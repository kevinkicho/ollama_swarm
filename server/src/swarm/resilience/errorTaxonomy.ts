// R17: structured error taxonomy.
// Pure classifier — no I/O. Caller passes error/string, gets back category + detail.

import type { ErrorCategory, ClassifiedError } from "./types.js";

export type { ErrorCategory, ClassifiedError };

function makeRecord(
  category: ErrorCategory,
  rawMessage: string,
): ClassifiedError {
  return {
    category,
    rawMessage,
    detail: humanReadableForCategory(category, rawMessage),
    retryable: isRetryableCategory(category),
  };
}

function humanReadableForCategory(
  category: ErrorCategory,
  raw: string,
): string {
  const trimmed = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  switch (category) {
    case "quota":
      return `Provider quota wall hit. Original: ${trimmed}`;
    case "network":
      return `Transient network failure. Original: ${trimmed}`;
    case "timeout":
      return `Request timed out (provider or watchdog). Original: ${trimmed}`;
    case "model-output":
      return `Model produced unparseable / empty output. Original: ${trimmed}`;
    case "auth":
      return `Provider auth failure (likely missing or invalid API key). Original: ${trimmed}`;
    case "disk":
      return `Disk / filesystem failure. Original: ${trimmed}`;
    case "oom":
      return `Process ran out of memory. Original: ${trimmed}`;
    case "runner-bug":
      return `Internal runner invariant failed (file a bug). Original: ${trimmed}`;
    case "user-stop":
      return `User aborted the run.`;
    case "cap":
      return `Hard cap reached (wall-clock / commits / todos).`;
    case "git":
      return `Git operation failed. Original: ${trimmed}`;
    case "unknown":
      return `Unclassified failure: ${trimmed}`;
  }
}

function isRetryableCategory(category: ErrorCategory): boolean {
  switch (category) {
    case "quota":
    case "network":
    case "timeout":
    case "model-output":
      return true;
    case "auth":
    case "disk":
    case "oom":
    case "runner-bug":
    case "user-stop":
    case "cap":
    case "git":
    case "unknown":
      return false;
  }
}

/** Pure classifier. Pattern-matches error message + optional HTTP status code. */
export function classifyError(input: {
  message: string;
  statusCode?: number;
  causeHint?: ErrorCategory;
}): ClassifiedError {
  const { message, statusCode, causeHint } = input;
  const raw = message ?? "";
  const lower = raw.toLowerCase();

  if (causeHint) {
    return makeRecord(causeHint, raw);
  }

  if (typeof statusCode === "number") {
    if (statusCode === 401 || statusCode === 403) {
      return makeRecord("auth", raw);
    }
    if (statusCode === 429) {
      return makeRecord("quota", raw);
    }
    if (statusCode >= 500 && statusCode < 600) {
      if (statusCode === 503 && /quota|rate.*limit|capacity/i.test(raw)) {
        return makeRecord("quota", raw);
      }
      return makeRecord("network", raw);
    }
  }

  if (/\b(quota|rate[\s-]?limit|too many requests|usage.*exceed|429)\b/i.test(raw)) {
    return makeRecord("quota", raw);
  }
  if (/\b(401|403|unauthor|invalid.*api.*key|forbidden|missing.*key)\b/i.test(raw)) {
    return makeRecord("auth", raw);
  }
  if (/\b(econnreset|econnrefused|enotfound|etimedout|tls|cert|ssl|fetch failed)\b/i.test(lower)) {
    return makeRecord("network", raw);
  }
  if (/\b(und_err_headers_timeout|headers timeout|aborterror|operation was aborted)\b/i.test(raw)) {
    return makeRecord("timeout", raw);
  }
  if (/\b(enospc|disk.*full|no space left)\b/i.test(lower)) {
    return makeRecord("disk", raw);
  }
  if (/\b(eacces|eperm|permission denied)\b/i.test(lower) && /git|clone|repo/i.test(lower)) {
    return makeRecord("disk", raw);
  }
  if (/\b(out of memory|heap.*out of|allocation failed|oom)\b/i.test(lower)) {
    return makeRecord("oom", raw);
  }
  if (/\b(cap.*reached|wall.?clock|commits cap|todos cap)\b/i.test(lower)) {
    return makeRecord("cap", raw);
  }
  if (/\b(empty response|malformed json|invalid json|parse|junk|model.*silence)\b/i.test(lower)) {
    return makeRecord("model-output", raw);
  }
  if (/\bgit\b/i.test(lower) && /(failed|fatal|reject|conflict)/i.test(lower)) {
    return makeRecord("git", raw);
  }
  if (/\b(invariant|impossible state|assertion|unreachable)\b/i.test(lower)) {
    return makeRecord("runner-bug", raw);
  }
  if (/\b(gemma4:31b-cloud|ollama.*error|context length exceeded)\b/i.test(raw)) {
    return makeRecord("model-output", raw);
  }
  if (/\b(user.*stop|stopped by user)\b/i.test(lower)) {
    return makeRecord("user-stop", raw);
  }
  return makeRecord("unknown", raw);
}

/** Aggregate ClassifiedError records into per-category counts. Pure. */
export function aggregateByCategory(
  errors: readonly ClassifiedError[],
): Record<ErrorCategory, number> {
  const out: Record<ErrorCategory, number> = {
    quota: 0,
    network: 0,
    timeout: 0,
    "model-output": 0,
    auth: 0,
    disk: 0,
    oom: 0,
    "runner-bug": 0,
    "user-stop": 0,
    cap: 0,
    git: 0,
    unknown: 0,
  };
  for (const e of errors) out[e.category] += 1;
  return out;
}