// 2026-05-02 (lever #1): retrieval-augmented context for MoA proposers.
//
// Pre-fix: proposers only saw the seed + a 50-file name list + a 2000-
// char README excerpt. Tasks that require code grounding (e.g. "audit
// the README claims against the implementation", "evaluate Express vs
// Fastify migration cost in this repo") had no actual file content
// to ground in — proposers produced generic answers because that's
// all they could see.
//
// This module pre-fetches a handful of high-value file excerpts before
// each MoA round and bakes them into the proposer prompt. Deterministic
// (vs full agentic tool dispatch) but covers the common case at a
// fraction of the complexity. Full agentic tools would need a refactor
// of BlackboardRunner.promptAgent into a shared helper — separate
// session.
//
// Heuristic for which files to pre-fetch:
//   1. Standard config files at the root (package.json, pyproject.toml,
//      tsconfig.json, Cargo.toml, go.mod, etc.) — ALWAYS included when
//      they exist. These carry structured truth about the project.
//   2. Files whose path contains any seed term (lowercased, ≥4 chars,
//      stop-words excluded) — surface task-relevant code.
//   3. Top-level source files (src/index.*, server.*, main.*) when no
//      better match — gives proposers a starting point.
//
// Each file is excerpted to FILE_EXCERPT_MAX chars (head only, since
// these are usually module declarations + the most important bits).
// Total budget capped at MAX_TOTAL_CHARS so a giant codebase doesn't
// blow the prompt context.

import { readFile } from "node:fs/promises";
import path from "node:path";

const FILE_EXCERPT_MAX = 1500;
const MAX_FILES_TO_FETCH = 8;
const MAX_TOTAL_CHARS = 8000;

// Stop-words excluded from seed-term matching. Otherwise "the", "and",
// "this", etc. would match every file path.
const STOP_WORDS = new Set([
  "this", "that", "with", "from", "have", "been", "they", "them", "what",
  "when", "where", "which", "while", "your", "user", "code", "file", "files",
  "list", "make", "find", "look", "check", "test", "into", "more", "than",
  "each", "every", "some", "must", "will", "would", "should", "could",
  "directive", "produce", "respond",
]);

// Standard top-level config / manifest files that carry structured
// truth about a project. Include when they exist — high signal, low
// cost (small files).
const ALWAYS_TRY = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "build.gradle",
  "pom.xml",
  "Gemfile",
  "composer.json",
];

export interface FileExcerpt {
  /** Repo-relative path (forward slashes for prompt consistency). */
  path: string;
  /** Up to FILE_EXCERPT_MAX chars of file content (head). */
  excerpt: string;
}

export interface GatherInput {
  clonePath: string;
  /** The proposer seed (typically "User directive: ..."). */
  seed: string;
  /** List of repo files (already produced by repoService.listRepoFiles).
   *  Used for the relevance-rank pass; this module does not re-walk. */
  repoFiles: readonly string[];
  /** Optional user-injected messages — terms here are ALSO treated as
   *  relevance signals. Important: a /say nudge like "focus on the
   *  retry logic" should pull in retry-related files. */
  userMessages?: readonly string[];
  /** 2026-05-02 (issue #5 fix): synthesis from prior round. When set,
   *  its file/symbol mentions are added to the relevance term set so
   *  round N+1's gather can pull files round 1 didn't anticipate.
   *  Closes the "static single-shot retrieval" gap. */
  priorSynthesis?: string;
  /** 2026-05-02 (issue #5 fix): files already in the prior round's
   *  excerpt set. The new gather will only return files NOT already
   *  in this set, so we can additively expand context across rounds
   *  without duplicating excerpts. Empty for round 1. */
  alreadyFetched?: readonly string[];
}

/** Extract content terms from seed + user messages + (optional)
 *  priorSynthesis for relevance ranking. Pure — exported for tests.
 *  Lowercase, ≥4 chars, stop-words excluded, deduplicated.
 *
 *  2026-05-02 (issue #5 fix): now accepts priorSynthesis. File names
 *  + symbol-shaped tokens (camelCase, snake_case) in the synthesis
 *  become relevance signals for round N+1's gather. */
export function extractSeedTerms(
  seed: string,
  userMessages?: readonly string[],
  priorSynthesis?: string,
): string[] {
  const all = [seed, ...(userMessages ?? []), priorSynthesis ?? ""].join(" ").toLowerCase();
  const tokens = all.match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (STOP_WORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Score each repo file by relevance to the seed terms. Pure — exported
 *  for tests. Higher score = more relevant. Returns a copy sorted
 *  descending by score; ties broken by ascending depth (shallow first).
 *
 *  Scoring:
 *    +5 per seed term present in the path basename (highest signal)
 *    +2 per seed term present anywhere in the path
 *    -1 per slash in path (penalty for deep-buried files)
 *    +3 if the basename matches a "code entrypoint" pattern (index/main/server) */
export function rankFilesByRelevance(
  repoFiles: readonly string[],
  seedTerms: readonly string[],
): Array<{ path: string; score: number }> {
  const ranked: Array<{ path: string; score: number }> = [];
  for (const file of repoFiles) {
    const lower = file.toLowerCase();
    const basename = lower.split("/").pop() ?? lower;
    let score = 0;
    for (const term of seedTerms) {
      if (basename.includes(term)) score += 5;
      else if (lower.includes(term)) score += 2;
    }
    const depth = (file.match(/\//g) ?? []).length;
    score -= depth;
    if (/^(index|main|server|app)\.[a-z]+$/.test(basename)) score += 3;
    ranked.push({ path: file, score });
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const depthA = (a.path.match(/\//g) ?? []).length;
    const depthB = (b.path.match(/\//g) ?? []).length;
    return depthA - depthB;
  });
  return ranked;
}

/** Read up to FILE_EXCERPT_MAX chars from a file (head). Returns null
 *  on read failure (file gone, permission denied, etc.). */
async function readExcerpt(absPath: string): Promise<string | null> {
  try {
    const content = await readFile(absPath, "utf8");
    return content.slice(0, FILE_EXCERPT_MAX);
  } catch {
    return null;
  }
}

/** Gather a small, high-relevance set of file excerpts for proposer
 *  prompts. Combines (a) always-try config files at the root with (b)
 *  the top relevance-ranked repo files until either MAX_FILES_TO_FETCH
 *  files OR MAX_TOTAL_CHARS chars is hit. Returns an empty array when
 *  no files could be read. */
export async function gatherProposerContext(input: GatherInput): Promise<FileExcerpt[]> {
  // 2026-05-02 (issue #5 fix): seed terms now incorporate priorSynthesis
  // so round N+1's gather pulls files round 1 didn't anticipate.
  const seedTerms = extractSeedTerms(input.seed, input.userMessages, input.priorSynthesis);
  const ranked = rankFilesByRelevance(input.repoFiles, seedTerms);

  const alreadyFetched = new Set(input.alreadyFetched ?? []);
  const picked: string[] = [];
  // Pass 1: always-try config files (only if present in repoFiles AND
  // not already fetched in a prior round).
  const repoFileSet = new Set(input.repoFiles);
  for (const cfg of ALWAYS_TRY) {
    if (repoFileSet.has(cfg) && !picked.includes(cfg) && !alreadyFetched.has(cfg)) {
      picked.push(cfg);
    }
  }
  // Pass 2: top relevance-ranked files until cap, skipping already-fetched.
  for (const r of ranked) {
    if (picked.length >= MAX_FILES_TO_FETCH) break;
    if (alreadyFetched.has(r.path)) continue;
    if (!picked.includes(r.path)) picked.push(r.path);
  }

  const out: FileExcerpt[] = [];
  let totalChars = 0;
  for (const file of picked) {
    if (out.length >= MAX_FILES_TO_FETCH) break;
    if (totalChars >= MAX_TOTAL_CHARS) break;
    const excerpt = await readExcerpt(path.join(input.clonePath, file));
    if (excerpt === null) continue;
    out.push({ path: file, excerpt });
    totalChars += excerpt.length;
  }
  return out;
}
