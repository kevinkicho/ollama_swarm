/**
 * Local endpoint catalog index for worker grounding (eee6718f PR4).
 *
 * Scans clone docs when present (zero network):
 *   - docs/API_ENDPOINTS.md
 *   - GOVERNMENT_API_CATALOG.md (repo root or docs/)
 *   - docs/PANELS.md
 *
 * Keyword match (FRED, BIS, OECD, IMF, panel names, routes, URLs) → top-K
 * markdown snippets for literature blackout / hard search fail paths.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Relative paths scanned under clone/catalog root (order = discover priority). */
export const LOCAL_CATALOG_REL_PATHS = [
  "docs/API_ENDPOINTS.md",
  "API_ENDPOINTS.md",
  "docs/GOVERNMENT_API_CATALOG.md",
  "GOVERNMENT_API_CATALOG.md",
  "docs/PANELS.md",
  "PANELS.md",
] as const;

const DEFAULT_MAX_SNIPPETS = 4;
const MAX_SNIPPET_CHARS = 1200;
const MAX_TOTAL_CHARS = 6000;

/** Well-known agency / source aliases → boost terms. */
const KEYWORD_ALIASES: ReadonlyArray<{ key: string; terms: string[] }> = [
  { key: "fred", terms: ["fred", "stlouisfed", "federal reserve economic data", "api.stlouisfed"] },
  { key: "bis", terms: ["bis", "bank for international settlements", "stats.bis", "bis.org"] },
  { key: "oecd", terms: ["oecd", "stats.oecd", "oecd.org"] },
  { key: "imf", terms: ["imf", "imf.org", "international monetary"] },
  { key: "ecb", terms: ["ecb", "european central bank", "sdw.ecb"] },
  { key: "worldbank", terms: ["worldbank", "world bank", "api.worldbank"] },
  { key: "eurostat", terms: ["eurostat", "ec.europa.eu"] },
  { key: "bls", terms: ["bls", "bureau of labor", "api.bls"] },
  { key: "bea", terms: ["bea", "bureau of economic analysis"] },
  { key: "census", terms: ["census", "api.census"] },
  { key: "boj", terms: ["boj", "bank of japan"] },
  { key: "boe", terms: ["boe", "bank of england"] },
];

export interface LocalCatalogLookupOpts {
  /** Clone working tree root (production path). */
  cloneRoot?: string;
  /** Explicit catalog root (tests / override; wins over cloneRoot). */
  catalogRoot?: string;
}

export interface CatalogSnippet {
  /** Relative source path, e.g. docs/API_ENDPOINTS.md */
  source: string;
  /** Nearest markdown heading, or file basename. */
  heading: string;
  /** Snippet body (heading + nearby lines). */
  body: string;
  /** Lowercased tokens for matching. */
  tokens: Set<string>;
  urls: string[];
}

interface CatalogIndex {
  root: string;
  snippets: CatalogSnippet[];
  builtAt: number;
}

const indexCache = new Map<string, CatalogIndex>();

/** Test / reconfig helper. */
export function clearLocalCatalogCache(): void {
  indexCache.clear();
}

function resolveRoot(opts?: LocalCatalogLookupOpts): string | undefined {
  const root = (opts?.catalogRoot ?? opts?.cloneRoot ?? "").trim();
  return root.length > 0 ? path.resolve(root) : undefined;
}

/** Common English / code tokens that should not drive catalog matches. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "from",
  "by", "as", "at", "is", "are", "be", "this", "that", "it", "its", "into",
  "via", "use", "using", "used", "add", "create", "update", "fix", "refactor",
  "pure", "string", "utility", "file", "files", "data", "src", "docs", "api",
  "panel", "panels", "endpoint", "endpoints", "route", "routes", "research",
  "official", "web", "http", "https", "com", "org", "js", "ts", "tsx", "md",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function extractUrls(text: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s)\]>"']+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[0].replace(/[.,;:]+$/, ""));
  }
  return out;
}

function extractRouteNames(text: string): string[] {
  const routes: string[] = [];
  // /api/foo, functions/src/routes/fred.js, panel registry keys
  const re =
    /(?:\/api\/[a-z0-9_/-]+|\broutes?\/[a-z0-9_.-]+|[A-Z][a-zA-Z0-9]*(?:Panel|Rates|Series)\b)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    routes.push(m[0]);
  }
  return routes;
}

/**
 * Split markdown into heading-bounded sections (ATX headings #–###).
 * Leading content before the first heading becomes one section.
 */
export function splitMarkdownSections(
  content: string,
): Array<{ heading: string; body: string }> {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ heading: string; body: string }> = [];
  let heading = "";
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join("\n").trim();
    if (!body && !heading) return;
    sections.push({ heading: heading || "(preamble)", body: body || heading });
    buf = [];
  };

  for (const line of lines) {
    const hm = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (hm) {
      flush();
      heading = hm[2].trim();
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function buildSnippetsFromFile(rel: string, content: string): CatalogSnippet[] {
  const sections = splitMarkdownSections(content);
  // If no headings, treat whole file as one snippet (truncated).
  const effective =
    sections.length > 0
      ? sections
      : [{ heading: path.basename(rel), body: content.slice(0, MAX_SNIPPET_CHARS) }];

  return effective
    .filter((s) => s.body.trim().length >= 20)
    .map((s) => {
      const body =
        s.body.length > MAX_SNIPPET_CHARS
          ? `${s.body.slice(0, MAX_SNIPPET_CHARS)}…`
          : s.body;
      const urls = extractUrls(s.body);
      const routes = extractRouteNames(s.body);
      const tokenList = [
        ...tokenize(`${s.heading}\n${body}`),
        ...urls.flatMap((u) => tokenize(u)),
        ...routes.flatMap((r) => tokenize(r)),
      ];
      return {
        source: rel,
        heading: s.heading,
        body,
        tokens: new Set(tokenList),
        urls,
      };
    });
}

/**
 * Explicitly build (and cache) the in-memory index for a root.
 * Lazy callers use {@link getLocalCatalogIndex} / {@link lookupLocalCatalog}.
 */
export function buildLocalCatalogIndex(root: string): CatalogSnippet[] {
  const abs = path.resolve(root);
  const snippets: CatalogSnippet[] = [];
  const seenAbs = new Set<string>();

  for (const rel of LOCAL_CATALOG_REL_PATHS) {
    const absFile = path.join(abs, rel);
    if (seenAbs.has(absFile)) continue;
    if (!existsSync(absFile)) continue;
    seenAbs.add(absFile);
    try {
      const content = readFileSync(absFile, "utf8");
      if (!content.trim()) continue;
      snippets.push(...buildSnippetsFromFile(rel.replace(/\\/g, "/"), content));
    } catch {
      // best-effort: skip unreadable files
    }
  }

  indexCache.set(abs, { root: abs, snippets, builtAt: Date.now() });
  return snippets;
}

export function getLocalCatalogIndex(root: string): CatalogSnippet[] {
  const abs = path.resolve(root);
  const cached = indexCache.get(abs);
  if (cached) return cached.snippets;
  return buildLocalCatalogIndex(abs);
}

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `haystack` contains `term` as a whole token / phrase.
 * Avoids false positives like Alfred→FRED or business→BIS from bare `includes`.
 */
export function textHasWholeTerm(haystack: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  const h = haystack.toLowerCase();
  if (t.includes(" ") || t.includes(".") || t.includes("/")) {
    // Multi-word or domain-ish phrases: require contiguous match with
    // non-letter boundaries (not mid-word).
    const re = new RegExp(
      `(?:^|[^a-z0-9])${escapeRegExp(t)}(?:[^a-z0-9]|$)`,
      "i",
    );
    return re.test(h);
  }
  // Single token: word boundary on both sides (alphanumeric edges).
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(t)}(?:[^a-z0-9]|$)`, "i");
  return re.test(h);
}

function expandQueryTerms(todoDescription: string): Set<string> {
  const raw = tokenize(todoDescription);
  const terms = new Set(raw);
  for (const alias of KEYWORD_ALIASES) {
    if (alias.terms.some((t) => textHasWholeTerm(todoDescription, t))) {
      for (const t of alias.terms) {
        for (const tok of tokenize(t)) terms.add(tok);
      }
      terms.add(alias.key);
    }
  }
  return terms;
}

function queryMentionsAlias(queryTerms: Set<string>, aliasKey: string, aliasTerms: string[]): boolean {
  if (queryTerms.has(aliasKey)) return true;
  for (const t of aliasTerms) {
    for (const tok of tokenize(t)) {
      if (queryTerms.has(tok)) return true;
    }
    // Exact multi-word / domain terms that survive as full query tokens
    if (queryTerms.has(t.toLowerCase())) return true;
  }
  return false;
}

function scoreSnippet(snippet: CatalogSnippet, queryTerms: Set<string>): number {
  if (queryTerms.size === 0) return 0;
  let score = 0;
  const headingLower = snippet.heading.toLowerCase();
  for (const term of queryTerms) {
    if (term.length < 3 || STOPWORDS.has(term)) continue;
    if (snippet.tokens.has(term)) score += term.length >= 4 ? 3 : 2;
    if (textHasWholeTerm(headingLower, term)) score += 4;
    for (const url of snippet.urls) {
      if (textHasWholeTerm(url, term) || url.toLowerCase().includes(term)) score += 5;
    }
  }
  // Agency alias boost when both query and snippet mention same key.
  for (const alias of KEYWORD_ALIASES) {
    if (!queryMentionsAlias(queryTerms, alias.key, alias.terms)) continue;
    const sHit =
      snippet.tokens.has(alias.key)
      || alias.terms.some((t) => tokenize(t).some((tok) => snippet.tokens.has(tok)))
      || snippet.urls.some((u) =>
        alias.terms.some((t) => textHasWholeTerm(u, t.split(" ")[0]!) || u.toLowerCase().includes(t.split(" ")[0]!)),
      );
    if (sHit) score += 10;
  }
  return score;
}

function formatSnippets(ranked: Array<{ snippet: CatalogSnippet; score: number }>): string {
  const parts: string[] = [];
  let total = 0;
  for (const { snippet } of ranked) {
    const block = [
      `### From ${snippet.source} — ${snippet.heading}`,
      snippet.body.trim(),
    ].join("\n");
    if (total + block.length > MAX_TOTAL_CHARS && parts.length > 0) break;
    parts.push(block);
    total += block.length;
  }
  if (parts.length === 0) return "";
  return [
    "LOCAL ENDPOINT CATALOG (offline clone docs — prefer these official URLs; do not invent endpoints):",
    ...parts,
  ].join("\n\n");
}

/**
 * Keyword-match local catalog docs against a todo description.
 * Returns a prompt-ready string of top-K snippets, or "" if no docs / no hits.
 * Zero network.
 */
export function lookupLocalCatalog(
  todoDescription: string,
  maxSnippets: number = DEFAULT_MAX_SNIPPETS,
  opts?: LocalCatalogLookupOpts,
): string {
  return lookupLocalCatalogRanked(todoDescription, maxSnippets, opts).notes;
}

export interface LocalCatalogRankedHit {
  /** Prompt-ready notes (empty if no hits). */
  notes: string;
  /** Best snippet score (0 if none). */
  bestScore: number;
  /** How many snippets ranked > 0. */
  hitCount: number;
}

/**
 * Same as lookupLocalCatalog but exposes scores for local-first gates.
 * Zero network.
 */
export function lookupLocalCatalogRanked(
  todoDescription: string,
  maxSnippets: number = DEFAULT_MAX_SNIPPETS,
  opts?: LocalCatalogLookupOpts,
): LocalCatalogRankedHit {
  const empty: LocalCatalogRankedHit = { notes: "", bestScore: 0, hitCount: 0 };
  const root = resolveRoot(opts);
  if (!root) return empty;
  if (!todoDescription || !todoDescription.trim()) return empty;

  let snippets: CatalogSnippet[];
  try {
    snippets = getLocalCatalogIndex(root);
  } catch {
    return empty;
  }
  if (snippets.length === 0) return empty;

  const queryTerms = expandQueryTerms(todoDescription);
  if (queryTerms.size === 0) return empty;

  const k = Math.max(1, Math.min(maxSnippets, 12));
  const ranked = snippets
    .map((snippet) => ({ snippet, score: scoreSnippet(snippet, queryTerms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.snippet.source.localeCompare(b.snippet.source));

  if (ranked.length === 0) return empty;
  const top = ranked.slice(0, k);
  return {
    notes: formatSnippets(top),
    bestScore: top[0]!.score,
    hitCount: ranked.length,
  };
}

/**
 * RR-C local-first: agency/panel alias hit (+10) or strong multi-term match.
 * Used by literature pre-pass and web_search tool to skip DDG when docs suffice.
 */
export const LOCAL_FIRST_MIN_SCORE = 10;
export const LOCAL_FIRST_MIN_CHARS = 150;

export function isStrongLocalCatalogHit(hit: LocalCatalogRankedHit): boolean {
  return (
    hit.bestScore >= LOCAL_FIRST_MIN_SCORE
    && hit.notes.length >= LOCAL_FIRST_MIN_CHARS
  );
}

/**
 * Shared helper for literature blackout / hard search fail paths.
 * Prefer this from council + blackboard workers so inject stays consistent.
 */
export function localCatalogNotesOnResearchFail(
  todoDescription: string,
  cloneRoot: string | undefined,
  maxSnippets: number = DEFAULT_MAX_SNIPPETS,
): string {
  if (!cloneRoot) return "";
  return lookupLocalCatalog(todoDescription, maxSnippets, { cloneRoot });
}

/**
 * Local-first gate for literature pre-pass and web_search.
 * Returns notes when catalog score is strong enough to skip web.
 */
export function tryLocalFirstCatalog(
  query: string,
  cloneRoot: string | undefined,
  maxSnippets: number = DEFAULT_MAX_SNIPPETS,
): LocalCatalogRankedHit | null {
  if (!cloneRoot) return null;
  const hit = lookupLocalCatalogRanked(query, maxSnippets, { cloneRoot });
  return isStrongLocalCatalogHit(hit) ? hit : null;
}
