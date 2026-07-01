import { extractFirstBalancedJson } from "./extractJson";

export interface ParsedHunk {
  op: "replace" | "create" | "append";
  file: string;
  search?: string;
  replace?: string;
  content?: string;
}

function parseLooseJson(raw: string): unknown {
  const s = raw.trim();
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { /* fall through */ }
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/m.exec(s);
  if (fence) {
    try { return JSON.parse(fence[1]!.trim()); } catch { /* fall through */ }
  }
  const firstBalanced = extractFirstBalancedJson(s);
  if (firstBalanced) {
    try { return JSON.parse(firstBalanced); } catch { /* fall through */ }
  }
  return undefined;
}

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
    } else if ((op === "create" || op === "append") && typeof ho.content === "string") {
      out.push({ op, file, content: ho.content });
    }
  }
  return out.length > 0 ? out : null;
}
