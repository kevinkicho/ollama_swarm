import { extractFirstBalancedJson } from "./extractJson";
import { applySoftJsonRepairs, stripJsonFences } from "./softJsonRepair";

export type ParsedHunkOp =
  | "replace"
  | "create"
  | "append"
  | "write"
  | "replace_between"
  | "delete";

export interface ParsedHunk {
  op: ParsedHunkOp;
  file: string;
  search?: string;
  replace?: string;
  content?: string;
  start?: string;
  endExclusive?: string;
}

function parseLooseJson(raw: string): unknown {
  const s = raw.trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const unfenced = stripJsonFences(s);
  for (const candidate of unfenced === s ? [s] : [unfenced, s]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through */
    }
    const soft = applySoftJsonRepairs(candidate);
    try {
      return JSON.parse(soft);
    } catch {
      /* fall through */
    }
  }
  const firstBalanced = extractFirstBalancedJson(s);
  if (firstBalanced) {
    try {
      return JSON.parse(firstBalanced);
    } catch {
      /* fall through */
    }
    try {
      return JSON.parse(applySoftJsonRepairs(firstBalanced));
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

function hunkFromObject(ho: Record<string, unknown>): ParsedHunk | null {
  const op = ho.op;
  const file = ho.file;
  if (typeof op !== "string" || typeof file !== "string") return null;
  if (op === "replace" && typeof ho.search === "string" && typeof ho.replace === "string") {
    return { op, file, search: ho.search, replace: ho.replace };
  }
  if ((op === "create" || op === "append" || op === "write") && typeof ho.content === "string") {
    return { op: op as "create" | "append" | "write", file, content: ho.content };
  }
  if (op === "replace_between" && typeof ho.start === "string" && typeof ho.replace === "string") {
    const end =
      typeof ho.endExclusive === "string"
        ? ho.endExclusive
        : ho.endExclusive === null || ho.endExclusive === undefined
          ? undefined
          : undefined;
    return {
      op: "replace_between",
      file,
      start: ho.start,
      ...(end ? { endExclusive: end } : {}),
      replace: ho.replace,
    };
  }
  if (op === "delete") return { op: "delete", file };
  return null;
}

/**
 * Display-only salvage when JSON.parse fails (unescaped quotes in search/replace).
 * Extracts op+file (+ best-effort body fields) so WorkerHunksBubble can still
 * show structured cards instead of a raw wall (2010479c / 120b2044).
 */
export function salvageWorkerHunksFromBrokenJson(raw: string): ParsedHunk[] | null {
  const s = stripJsonFences(raw);
  if (!/"hunks"\s*:/i.test(s) && !/"op"\s*:/.test(s)) return null;
  const out: ParsedHunk[] = [];
  // Split on hunk-ish object starts: {"op": or { "op":
  const parts = s.split(/\{\s*"op"\s*:/);
  for (let i = 1; i < parts.length; i++) {
    const chunk = `"op":` + parts[i]!;
    const opM = /^"op"\s*:\s*"(replace|create|append|write|replace_between|delete)"/.exec(chunk);
    if (!opM) continue;
    const op = opM[1] as ParsedHunkOp;
    const fileM = /"file"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(chunk);
    if (!fileM) continue;
    const file = fileM[1]!.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");

    // Best-effort string fields — may be truncated when model left unescaped quotes.
    const field = (key: string): string | undefined => {
      const re = new RegExp(`"${key}"\\s*:\\s*"`);
      const m = re.exec(chunk);
      if (!m || m.index === undefined) return undefined;
      const start = m.index + m[0].length;
      let out = "";
      let esc = false;
      for (let j = start; j < chunk.length; j++) {
        const ch = chunk[j]!;
        if (esc) {
          if (ch === "n") out += "\n";
          else if (ch === "t") out += "\t";
          else if (ch === "r") out += "\r";
          else if (ch === '"') out += '"';
          else if (ch === "\\") out += "\\";
          else out += ch;
          esc = false;
          continue;
        }
        if (ch === "\\") {
          esc = true;
          continue;
        }
        if (ch === '"') {
          // End of string only if followed by , or } or whitespace+those
          const rest = chunk.slice(j + 1).match(/^\s*([,}\]])/);
          if (rest) return out;
          // Unescaped quote mid-value — keep as quote and continue (salvage)
          out += '"';
          continue;
        }
        out += ch;
        // Cap runaway salvage bodies
        if (out.length > 50_000) return out;
      }
      return out.length > 0 ? out : undefined;
    };

    if (op === "replace") {
      const search = field("search") ?? "";
      const replace = field("replace") ?? "";
      out.push({ op, file, search, replace });
    } else if (op === "create" || op === "append" || op === "write") {
      out.push({ op, file, content: field("content") ?? "" });
    } else if (op === "replace_between") {
      out.push({
        op,
        file,
        start: field("start") ?? "",
        replace: field("replace") ?? "",
      });
    } else if (op === "delete") {
      out.push({ op, file });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Client-side hunk extraction for transcript bubbles when server summary
 * tagging is missing. Supports replace_between / write (2010479c UI raw JSON).
 * Falls back to display salvage when JSON is invalid (raw newlines, bare
 * keys, unescaped quotes in code snippets).
 */
export function tryParseWorkerHunks(rawJson: string): ParsedHunk[] | null {
  const parsed = parseLooseJson(rawJson);
  if (typeof parsed === "object" && parsed !== null) {
    const hunks = (parsed as { hunks?: unknown }).hunks;
    if (Array.isArray(hunks)) {
      const out: ParsedHunk[] = [];
      for (const h of hunks) {
        if (typeof h !== "object" || h === null) continue;
        const one = hunkFromObject(h as Record<string, unknown>);
        if (one) out.push(one);
      }
      if (out.length > 0) return out;
    }
  }
  return salvageWorkerHunksFromBrokenJson(rawJson);
}
