/**
 * Q11: on-disk store for successful (todo → hunks) pairs used by hunkRag.
 * Separate from `.swarm-memory.jsonl` (lessons) so validation stays simple.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PastHunkExample } from "./hunkRag.js";

export const HUNK_RAG_FILENAME = ".swarm-hunk-examples.jsonl";
export const HUNK_RAG_FILE_BUDGET_BYTES = 512 * 1024; // 512 KB
export const HUNK_RAG_MAX_RESPONSE_CHARS = 2000;

export function hunkRagFilePath(clonePath: string): string {
  return path.join(clonePath, HUNK_RAG_FILENAME);
}

export function isValidPastHunkExample(x: unknown): x is PastHunkExample {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.todoDescription !== "string" || o.todoDescription.trim().length === 0) {
    return false;
  }
  if (!Array.isArray(o.expectedFiles)) return false;
  if (!o.expectedFiles.every((f) => typeof f === "string")) return false;
  if (typeof o.hunkResponse !== "string" || o.hunkResponse.trim().length === 0) {
    return false;
  }
  return true;
}

/** Serialize approved hunks for few-shot storage (bounded). */
export function serializeHunksForRag(hunks: readonly unknown[]): string {
  try {
    const raw = JSON.stringify({ hunks });
    if (raw.length <= HUNK_RAG_MAX_RESPONSE_CHARS) return raw;
    return raw.slice(0, HUNK_RAG_MAX_RESPONSE_CHARS) + "…";
  } catch {
    return String(hunks).slice(0, HUNK_RAG_MAX_RESPONSE_CHARS);
  }
}

export async function readHunkExamples(clonePath: string): Promise<PastHunkExample[]> {
  const file = hunkRagFilePath(clonePath);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: PastHunkExample[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isValidPastHunkExample(parsed)) out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Append one successful example. Best-effort size trim when over budget.
 * Returns post-write example count (approx).
 */
export async function appendHunkExample(
  clonePath: string,
  example: PastHunkExample,
): Promise<number> {
  if (!isValidPastHunkExample(example)) return 0;
  const file = hunkRagFilePath(clonePath);
  const entry: PastHunkExample = {
    todoDescription: example.todoDescription.trim().slice(0, 500),
    expectedFiles: example.expectedFiles.slice(0, 20).map(String),
    hunkResponse: example.hunkResponse.trim().slice(0, HUNK_RAG_MAX_RESPONSE_CHARS),
    ...(example.runId ? { runId: example.runId } : {}),
    ...(example.ts != null ? { ts: example.ts } : { ts: Date.now() }),
  };
  const line = JSON.stringify(entry) + "\n";

  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
  } catch {
    /* ignore */
  }

  let existing = "";
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let next = existing + line;
  if (Buffer.byteLength(next, "utf8") > HUNK_RAG_FILE_BUDGET_BYTES) {
    const lines = next.split("\n").filter((l) => l.trim().length > 0);
    const keep = Math.max(20, Math.floor(lines.length / 2));
    next = lines.slice(-keep).join("\n") + "\n";
  }

  await fs.writeFile(file, next, "utf8");
  return next.split("\n").filter((l) => l.trim().length > 0).length;
}
