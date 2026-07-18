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

/**
 * Client-side hunk extraction for transcript bubbles when server summary
 * tagging is missing. Supports replace_between / write (2010479c UI raw JSON).
 */
export function tryParseWorkerHunks(rawJson: string): ParsedHunk[] | null {
  const parsed = parseLooseJson(rawJson);
  if (typeof parsed !== "object" || parsed === null) return null;
  const hunks = (parsed as { hunks?: unknown }).hunks;
  if (!Array.isArray(hunks)) return null;
  const out: ParsedHunk[] = [];
  for (const h of hunks) {
    if (typeof h !== "object" || h === null) continue;
    const ho = h as Record<string, unknown>;
    const op = ho.op;
    const file = ho.file;
    if (typeof op !== "string" || typeof file !== "string") continue;
    if (op === "replace" && typeof ho.search === "string" && typeof ho.replace === "string") {
      out.push({ op, file, search: ho.search, replace: ho.replace });
    } else if ((op === "create" || op === "append" || op === "write") && typeof ho.content === "string") {
      out.push({ op: op as "create" | "append" | "write", file, content: ho.content });
    } else if (op === "replace_between" && typeof ho.start === "string" && typeof ho.replace === "string") {
      const end =
        typeof ho.endExclusive === "string"
          ? ho.endExclusive
          : ho.endExclusive === null || ho.endExclusive === undefined
            ? undefined
            : undefined;
      out.push({
        op: "replace_between",
        file,
        start: ho.start,
        ...(end ? { endExclusive: end } : {}),
        replace: ho.replace,
      });
    } else if (op === "delete") {
      out.push({ op: "delete", file });
    }
  }
  return out.length > 0 ? out : null;
}
