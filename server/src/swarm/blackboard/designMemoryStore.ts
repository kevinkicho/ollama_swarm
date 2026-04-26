// Task #177: long-horizon DESIGN memory across runs.
//
// While memoryStore.ts (#130) captures "lessons learned" — what to
// avoid / what to build on technically — designMemoryStore captures
// the CREATIVE / PRODUCT north-star: what is this codebase trying
// to BECOME, what high-level decisions have been made, what's next
// on the roadmap.
//
// Three markdown files at <clone>/.swarm-design/:
//   - north-star.md   The 1-2 paragraph long-term vision. Overwritten
//                     on each update (latest = current).
//   - decisions.md    Append-only log of design decisions, each with
//                     a date header + 1-3 line rationale. Mirrors
//                     ADRs (architecture decision records).
//   - roadmap.md      Ranked top-N next features. Overwritten on each
//                     update (latest = current).
//
// Why markdown not JSONL: humans should be able to edit these by
// hand. The user might want to add/refine the north-star
// independently of any swarm run. JSONL would force a programmatic
// edit path.
//
// Read at planner-seed time + writeable by a post-run reflection
// pass (parallel to runMemoryDistillationPass).

import { promises as fs } from "node:fs";
import path from "node:path";

export const DESIGN_DIR_NAME = ".swarm-design";
export const NORTH_STAR_FILE = "north-star.md";
export const DECISIONS_FILE = "decisions.md";
export const ROADMAP_FILE = "roadmap.md";
// Soft caps so a runaway model can't blow up the on-disk size or the
// next planner seed. North-star caps to 2 paragraphs; roadmap to 10
// items; per-decision body to 500 chars.
export const NORTH_STAR_MAX_CHARS = 2000;
export const ROADMAP_MAX_ITEMS = 10;
export const DECISION_MAX_CHARS = 500;
// How many recent decisions the planner seed surfaces. Older
// decisions stay on disk for human review but don't get re-fed to
// the planner each run (recency bias dominates beyond ~5).
export const DECISIONS_SEED_RECENT_COUNT = 5;

export interface DesignMemory {
  /** undefined when the file doesn't exist (first run on this clone). */
  northStar?: string;
  /** All decisions, oldest first. Empty when no file. */
  decisions: DecisionEntry[];
  /** Roadmap items in priority order. Empty when no file. */
  roadmap: string[];
}

export interface DecisionEntry {
  /** ISO date (YYYY-MM-DD) the decision was made. */
  date: string;
  /** 1-line title (the "## " heading line in markdown). */
  title: string;
  /** Free-text rationale below the heading. */
  body: string;
}

function designDir(clonePath: string): string {
  return path.join(clonePath, DESIGN_DIR_NAME);
}

async function readFileOrEmpty(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function readDesignMemory(clonePath: string): Promise<DesignMemory> {
  const dir = designDir(clonePath);
  const [nsRaw, decRaw, rmRaw] = await Promise.all([
    readFileOrEmpty(path.join(dir, NORTH_STAR_FILE)),
    readFileOrEmpty(path.join(dir, DECISIONS_FILE)),
    readFileOrEmpty(path.join(dir, ROADMAP_FILE)),
  ]);
  const northStar = nsRaw?.trim() || undefined;
  const decisions = parseDecisionsMd(decRaw ?? "");
  const roadmap = parseRoadmapMd(rmRaw ?? "");
  return { northStar, decisions, roadmap };
}

// Parse decisions.md — sections delimited by "## YYYY-MM-DD · <title>".
// Body is everything until the next "## " line or EOF.
export function parseDecisionsMd(raw: string): DecisionEntry[] {
  const out: DecisionEntry[] = [];
  if (!raw.trim()) return out;
  const lines = raw.split(/\r?\n/);
  let current: { date: string; title: string; bodyLines: string[] } | null = null;
  for (const line of lines) {
    const m = /^##\s+(\d{4}-\d{2}-\d{2})\s*[·\-:]\s*(.+)$/.exec(line);
    if (m) {
      if (current) {
        out.push({
          date: current.date,
          title: current.title.trim(),
          body: current.bodyLines.join("\n").trim().slice(0, DECISION_MAX_CHARS),
        });
      }
      current = { date: m[1], title: m[2], bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) {
    out.push({
      date: current.date,
      title: current.title.trim(),
      body: current.bodyLines.join("\n").trim().slice(0, DECISION_MAX_CHARS),
    });
  }
  return out;
}

// Parse roadmap.md — numbered items "1. ..." or "- ...".
// Stops at first blank-paragraph or non-list line.
export function parseRoadmapMd(raw: string): string[] {
  const out: string[] = [];
  if (!raw.trim()) return out;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) continue;
    const m = /^(?:\d+\.|[-*])\s+(.+)$/.exec(t);
    if (!m) continue; // ignore lines that aren't list items
    out.push(m[1].trim());
    if (out.length >= ROADMAP_MAX_ITEMS) break;
  }
  return out;
}

// Render the design memory for the planner seed. Empty fields are
// omitted so a clone with no design memory yet doesn't bloat the
// prompt with placeholder headers.
export function renderDesignMemoryForSeed(mem: DesignMemory): string | undefined {
  const blocks: string[] = [];
  if (mem.northStar) {
    blocks.push(`=== DESIGN NORTH STAR ===\n${mem.northStar}\n=== END ===`);
  }
  if (mem.roadmap.length > 0) {
    const items = mem.roadmap.slice(0, ROADMAP_MAX_ITEMS);
    blocks.push(
      `=== DESIGN ROADMAP (top ${items.length}) ===\n` +
        items.map((it, i) => `${i + 1}. ${it}`).join("\n") +
        `\n=== END ===`,
    );
  }
  if (mem.decisions.length > 0) {
    const recent = mem.decisions.slice(-DECISIONS_SEED_RECENT_COUNT);
    blocks.push(
      `=== RECENT DESIGN DECISIONS (${recent.length} most recent) ===\n` +
        recent
          .map((d) => `## ${d.date} · ${d.title}\n${d.body}`)
          .join("\n\n") +
        `\n=== END ===`,
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

// Writers — overwrite north-star + roadmap (current snapshot wins);
// append to decisions.md (history record).

export async function writeNorthStar(clonePath: string, text: string): Promise<void> {
  const dir = designDir(clonePath);
  await fs.mkdir(dir, { recursive: true });
  const trimmed = text.trim().slice(0, NORTH_STAR_MAX_CHARS);
  if (!trimmed) return;
  await fs.writeFile(
    path.join(dir, NORTH_STAR_FILE),
    `# Design North Star\n\n${trimmed}\n`,
    "utf8",
  );
}

export async function writeRoadmap(clonePath: string, items: string[]): Promise<void> {
  const dir = designDir(clonePath);
  await fs.mkdir(dir, { recursive: true });
  const cleaned = items
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, ROADMAP_MAX_ITEMS);
  if (cleaned.length === 0) return;
  const md =
    `# Roadmap\n\nTop ${cleaned.length} next features (priority order):\n\n` +
    cleaned.map((it, i) => `${i + 1}. ${it}`).join("\n") +
    `\n`;
  await fs.writeFile(path.join(dir, ROADMAP_FILE), md, "utf8");
}

export async function appendDecisions(
  clonePath: string,
  newDecisions: Array<{ title: string; body: string }>,
): Promise<void> {
  if (newDecisions.length === 0) return;
  const dir = designDir(clonePath);
  await fs.mkdir(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const filePath = path.join(dir, DECISIONS_FILE);
  const existing = (await readFileOrEmpty(filePath)) ?? "# Design Decisions\n\n";
  const additions = newDecisions
    .map((d) => {
      const title = d.title.trim().slice(0, 200);
      const body = d.body.trim().slice(0, DECISION_MAX_CHARS);
      if (!title) return null;
      return `## ${today} · ${title}\n${body}`.trim();
    })
    .filter((s): s is string => Boolean(s));
  if (additions.length === 0) return;
  const next =
    existing.trimEnd() + "\n\n" + additions.join("\n\n") + "\n";
  await fs.writeFile(filePath, next, "utf8");
}

// Parse the planner's update-pass response. Expected shape:
//   { northStar?: string, newDecisions?: [{title, body}], roadmap?: string[] }
// Lenient — missing fields are ok (means "no change to that field").
export function parseDesignUpdateResponse(
  raw: string,
): { northStar?: string; newDecisions: Array<{ title: string; body: string }>; roadmap: string[] } {
  const out = { newDecisions: [] as Array<{ title: string; body: string }>, roadmap: [] as string[] } as {
    northStar?: string;
    newDecisions: Array<{ title: string; body: string }>;
    roadmap: string[];
  };
  let parsed: unknown;
  // Strip code fences if present.
  const stripped = raw
    .replace(/^[\s\S]*?```(?:json)?\n/, "")
    .replace(/\n```[\s\S]*$/, "")
    .trim();
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Try to find a JSON object embedded in the text.
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return out;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return out;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return out;
  const o = parsed as Record<string, unknown>;
  if (typeof o.northStar === "string" && o.northStar.trim().length > 0) {
    out.northStar = o.northStar;
  }
  if (Array.isArray(o.newDecisions)) {
    for (const d of o.newDecisions) {
      if (typeof d !== "object" || d === null) continue;
      const dd = d as Record<string, unknown>;
      const title = typeof dd.title === "string" ? dd.title : "";
      const body = typeof dd.body === "string" ? dd.body : "";
      if (title.trim().length > 0) out.newDecisions.push({ title, body });
    }
  }
  if (Array.isArray(o.roadmap)) {
    for (const it of o.roadmap) {
      if (typeof it === "string" && it.trim().length > 0) out.roadmap.push(it);
    }
  }
  return out;
}
