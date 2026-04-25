// Task #130: persistent cross-run memory store.
//
// Each clone gets a `.swarm-memory.jsonl` file at its root. On successful
// run completion, the planner produces 2-4 lessons-learned bullets from
// the run's contract + commits + verdicts; we append a single MemoryEntry
// line. On next run start (before planner sees the seed), we read the
// most recent N entries and surface them in the planner seed as a
// "Prior runs on this clone" section.
//
// Why JSONL not JSON-array: append-only writes don't need a read-modify-
// write of the whole file. Two concurrent runs against the same clone
// can each fsync their own line without clobbering. (We don't actually
// support concurrent runs against the same clone today, but the on-disk
// shape stays robust for free.)
//
// Size discipline: we cap the file at MEMORY_FILE_BUDGET_BYTES (~1 MB).
// When a write would push past that, we keep the most recent half of
// the entries by line count and rewrite the file. Bounded I/O so a
// long-running clone doesn't accumulate an unbounded log; bounded read
// time so the next run's seed isn't blocked on parsing megabytes.

import { promises as fs } from "node:fs";
import path from "node:path";

export const MEMORY_FILENAME = ".swarm-memory.jsonl";
export const MEMORY_FILE_BUDGET_BYTES = 1 * 1024 * 1024; // 1 MB
// How many recent entries the planner seed surfaces. Beyond ~5 the
// planner starts ignoring them (recency bias dominates) per #127's
// goal-generation observations on long contexts.
export const MEMORY_SEED_RECENT_COUNT = 5;
// Soft cap on lessons per entry. The curator prompt asks for 2-4; this
// is the schema-level guard so a runaway model can't bloat the file.
export const MEMORY_MAX_LESSONS_PER_ENTRY = 8;

export interface MemoryEntry {
  /** Unix-ms timestamp the run that produced these lessons completed. */
  ts: number;
  /** App-level runId (Unit 52d) so an entry can be cross-referenced to its summary.json. */
  runId: string;
  /** Ambition tier reached at completion. */
  tier: number;
  /** Total commits the run landed. */
  commits: number;
  /** Free-text lessons-learned bullets, 2-4 typical, capped at MEMORY_MAX_LESSONS_PER_ENTRY. */
  lessons: string[];
}

export function memoryFilePath(clonePath: string): string {
  return path.join(clonePath, MEMORY_FILENAME);
}

// Pure validation — useful from prompt-parsers and tests, no I/O.
export function isValidMemoryEntry(x: unknown): x is MemoryEntry {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts) || o.ts <= 0) return false;
  if (typeof o.runId !== "string" || o.runId.length === 0) return false;
  if (typeof o.tier !== "number" || !Number.isInteger(o.tier) || o.tier < 0) return false;
  if (typeof o.commits !== "number" || !Number.isInteger(o.commits) || o.commits < 0) return false;
  if (!Array.isArray(o.lessons)) return false;
  if (o.lessons.length === 0) return false;
  if (o.lessons.length > MEMORY_MAX_LESSONS_PER_ENTRY) return false;
  return o.lessons.every((l) => typeof l === "string" && l.trim().length > 0);
}

// Read all valid entries from the memory file. Missing file → []. A
// malformed line is skipped silently (log noise about ancient format
// changes isn't useful) but valid lines around it are kept.
export async function readMemory(clonePath: string): Promise<MemoryEntry[]> {
  const file = memoryFilePath(clonePath);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: MemoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isValidMemoryEntry(parsed)) out.push(parsed);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

// Most-recent-first slice. Used by the planner seed builder so the
// "Prior runs" section leads with the freshest context.
export async function readRecentMemory(
  clonePath: string,
  count: number = MEMORY_SEED_RECENT_COUNT,
): Promise<MemoryEntry[]> {
  const all = await readMemory(clonePath);
  if (all.length === 0) return [];
  // Sort by ts ascending then take the last `count`. Reverse so the
  // freshest is first when the seed renders the bullet list.
  const sorted = [...all].sort((a, b) => a.ts - b.ts);
  return sorted.slice(-count).reverse();
}

// Append a single entry. Self-trims when the on-disk file would otherwise
// exceed MEMORY_FILE_BUDGET_BYTES — keeps the most recent half by entry
// count and rewrites. Returns the post-write entry count.
export async function appendMemoryEntry(
  clonePath: string,
  entry: MemoryEntry,
): Promise<number> {
  if (!isValidMemoryEntry(entry)) {
    throw new Error("appendMemoryEntry: entry failed schema validation");
  }
  const file = memoryFilePath(clonePath);
  const line = JSON.stringify(entry) + "\n";

  // Compute would-be size after append. fs.stat → ENOENT on missing file
  // is fine; we treat that as size 0.
  let currentSize = 0;
  try {
    const stat = await fs.stat(file);
    currentSize = stat.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (currentSize + line.length <= MEMORY_FILE_BUDGET_BYTES) {
    await fs.appendFile(file, line, "utf8");
    return countEntries(file);
  }

  // Over budget: read all, keep last half + new entry, rewrite atomically.
  const all = await readMemory(clonePath);
  const keep = all.slice(Math.floor(all.length / 2));
  keep.push(entry);
  const body = keep.map((e) => JSON.stringify(e)).join("\n") + "\n";
  // Write to a temp file then rename — same atomic-write recipe used
  // elsewhere (see writeFileAtomic.ts) but inlined here to avoid an
  // import cycle for one call site.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, file);
  return keep.length;
}

async function countEntries(file: string): Promise<number> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

// Parse the memory-distillation response. The planner is asked for
// {"lessons": ["...", "..."]}. Tolerant of fenced JSON and prose-prefix
// (matches stripFences pattern used elsewhere). Returns at most
// MEMORY_MAX_LESSONS_PER_ENTRY non-empty trimmed strings; empty array
// on any parse failure (the caller treats that as "nothing memorable").
export function parseMemoryLessons(text: string): string[] {
  const tryParse = (raw: string): unknown => {
    try {
      return JSON.parse(raw.trim());
    } catch {
      return null;
    }
  };
  let parsed = tryParse(text);
  if (!parsed) {
    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
    if (fenced) parsed = tryParse(fenced[1]!);
  }
  if (!parsed) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) parsed = tryParse(text.slice(first, last + 1));
  }
  if (!parsed || typeof parsed !== "object") return [];
  const lessons = (parsed as { lessons?: unknown }).lessons;
  if (!Array.isArray(lessons)) return [];
  return lessons
    .filter((l): l is string => typeof l === "string")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, MEMORY_MAX_LESSONS_PER_ENTRY);
}

// Render a planner-seed-ready section from a list of recent entries.
// Empty input → empty string (caller can conditionally include the
// header). Used by the planner seed builder to inject prior-run context.
export function renderMemoryForSeed(entries: ReadonlyArray<MemoryEntry>): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  lines.push("=== Prior runs on this clone (most recent first) ===");
  for (const e of entries) {
    const dateStr = new Date(e.ts).toISOString().slice(0, 16).replace("T", " ");
    lines.push(`- ${dateStr} · runId ${e.runId.slice(0, 8)} · tier ${e.tier} · ${e.commits} commits`);
    for (const lesson of e.lessons) {
      lines.push(`    · ${lesson}`);
    }
  }
  lines.push("=== END prior runs ===");
  lines.push(
    "Use these lessons to AVOID rediscovering known dead-ends and to BUILD on what previously worked. Don't slavishly follow them — if you see a better path, take it.",
  );
  return lines.join("\n");
}
