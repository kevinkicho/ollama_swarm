/**
 * Built-in web_fetch / web_search for research profiles.
 * Extracted from ToolDispatcher.ts.
 *
 * web_search uses pluggable adapters (searchAdapters.ts): DDG HTML → DDG lite →
 * optional BRAVE / SERPER / BING when keys are set. First success wins.
 * Never invents results. Shared per-process rate limit with web_fetch.
 */

import { isBlockedWebFetchUrl } from "./ssrfGuard.js";
import {
  GOV_DOMAINS,
  getSearchAdapters,
  searchWithAdapters,
  type FetchLike,
  type SearchLink,
} from "./searchAdapters.js";

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string };


// ---------------------------------------------------------------------------
// External / MCP-style tools (web access for research).
// These are opt-in (via swarm-research profile or explicit enable).
// Safety: bounded output, timeouts, basic user-agent. No auth by default.
// For governmental data searches, the model can target .gov / .eu / data.gov etc.
// ---------------------------------------------------------------------------

const WEB_TIMEOUT_MS = 30_000;
const WEB_OUTPUT_CAP = 100 * 1024; // 100KB max per fetch

const RATE_LIMIT_MS = 2000; // simple per-process rate limit between searches
let lastWebCall = 0;

/** Placeholder / training-data URLs that never exist — refuse early with guidance. */
const PLACEHOLDER_HOST_RE =
  /your-org|your-repo|example\.com|example\.org|localhost|127\.0\.0\.1|0\.0\.0\.0/i;

/** Shared rate limit for web_fetch + web_search (per process). */
export async function applyWebRateLimit(): Promise<void> {
  const now = Date.now();
  if (now - lastWebCall < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - (now - lastWebCall)));
  }
  lastWebCall = Date.now();
}

/** Test helper — reset rate-limit clock. */
export function _resetWebRateLimitForTests(): void {
  lastWebCall = 0;
}

export async function webFetchTool(args: Record<string, unknown>): Promise<ToolResult> {
  const url = String(args.url ?? "").trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return {
      ok: false,
      error:
        "web_fetch: valid http/https url required. " +
        "For files inside the clone use the `read` / `grep` / `list` tools — not file:// or inventing GitHub raw URLs.",
    };
  }
  if (PLACEHOLDER_HOST_RE.test(url) || /raw\.githubusercontent\.com\/your-/i.test(url)) {
    return {
      ok: false,
      error:
        "web_fetch refused: URL looks like a placeholder (your-org/your-repo/example.com). " +
        "Read local repo paths with the `read` tool instead of inventing remote URLs.",
    };
  }
  const ssrf = isBlockedWebFetchUrl(url);
  if (ssrf.blocked) {
    return { ok: false, error: `web_fetch refused: ${ssrf.reason}` };
  }

  await applyWebRateLimit();

  // Gov domain preference (soft filter / note)
  const u = url.toLowerCase();
  const isGov = GOV_DOMAINS.some(d => u.includes(d)) || u.includes(".gov") || u.includes(".eu");
  if (!isGov) {
    // still allow but note
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "ollama-swarm-research/1.0 (research agent; +https://github.com/kevinkicho/ollama_swarm)",
        "Accept": "text/html,application/json,text/plain,*/*",
      },
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, error: `web_fetch: HTTP ${res.status} ${res.statusText}` };
    }

    const contentType = res.headers.get("content-type") || "";
    let rawText: string;
    if (contentType.includes("application/json")) {
      const json = await res.json();
      rawText = JSON.stringify(json, null, 2);
    } else {
      rawText = await res.text();
    }

    if (rawText.length > WEB_OUTPUT_CAP) {
      rawText = rawText.slice(0, WEB_OUTPUT_CAP) + "\n…(truncated)";
    }

    // Improved structured output for research use cases.
    let title = "";
    const titleMatch = rawText.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim().slice(0, 150);

    // Better main content extraction for HTML: try multiple high-signal containers,
    // prefer content-like IDs/classes, fall back to body text heuristics.
    // This improves signal for research/gov data pages that bury main content.
    let mainContent = rawText;
    if (!contentType.includes("application/json") && !contentType.includes("text/plain")) {
      // Try several preferred containers in priority order. Enhanced for better research page extraction.
      const containerMatch =
        rawText.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
        rawText.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
        rawText.match(/<div[^>]*\b(id|class)=["'][^"']*(content|main-content|article|post|entry|primary|main|app-content|page-content) [^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
        rawText.match(/<section[^>]*\b(id|class)=["'][^"']*(content|main|article|primary) [^"']*["'][^>]*>([\s\S]*?)<\/section>/i) ||
        rawText.match(/<div[^>]*\b(id|class)=["'][^"']*main[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

      if (containerMatch) {
        mainContent = (containerMatch[1] || containerMatch[3] || containerMatch[0] || "")
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 8000);
      } else {
        mainContent = rawText
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 8000);
      }
    } else {
      mainContent = rawText.slice(0, 8000);
    }

    const prefix = isGov ? "[GOV / OFFICIAL SOURCE] " : "";
    let structured = `${prefix}URL: ${res.url}\n`;
    if (title) structured += `Title: ${title}\n`;
    structured += `Content:\n${mainContent}`;

    return { ok: true, output: structured };
  } catch (err: any) {
    const msg = err?.name === "AbortError" ? "timeout" : (err?.message || String(err));
    return { ok: false, error: `web_fetch failed: ${msg}` };
  }
}

function formatSearchResults(query: string, links: SearchLink[], backend: string): ToolResult {
  const queryLower = query.toLowerCase();
  const isGovQuery = /gov|governmental|government|official|data endpoint|api|bis|imf|world bank/i.test(queryLower);
  let filtered = links;
  if (isGovQuery) {
    filtered = links.filter(
      (l) =>
        GOV_DOMAINS.some((d) => l.url.toLowerCase().includes(d)) ||
        l.url.toLowerCase().includes(".gov") ||
        l.url.toLowerCase().includes(".eu"),
    );
    if (filtered.length === 0) filtered = links;
  }
  filtered.sort((a, b) => b.score - a.score);

  const results: string[] = [];
  for (const r of filtered.slice(0, 10)) {
    let entry = `Result:\n  Title: ${r.title}\n  URL: ${r.url}`;
    if (r.snippet) entry += `\n  Snippet: ${r.snippet}`;
    entry += `\n  RelevanceScore: ${r.score}`;
    if (
      GOV_DOMAINS.some((d) => r.url.toLowerCase().includes(d)) ||
      r.url.toLowerCase().includes(".gov") ||
      r.url.toLowerCase().includes(".eu")
    ) {
      entry += ` (Official/Gov source)`;
    }
    results.push(entry);
  }

  if (results.length === 0) {
    return {
      ok: true,
      output:
        `Search for "${query}" via ${backend}: no structured results extracted. ` +
        `Prefer local repo tools (read/grep) for code paths, or web_fetch a known official URL ` +
        `(e.g. stats.bis.org, api.worldbank.org, fred.stlouisfed.org).`,
    };
  }

  return {
    ok: true,
    output:
      `Web search results for: ${query}\n(backend: ${backend})\n\n${results.join("\n\n")}\n\n` +
      `Tip: Use web_fetch on the most relevant official URLs. ` +
      `Do NOT invent raw.githubusercontent.com/your-org/... placeholders — use read for local files.`,
  };
}

/**
 * Best-effort local catalog notes on total search failure (PR4).
 * Dynamic import avoids circular deps if research layer ever imports tools.
 */
async function localCatalogFailNotes(
  query: string,
  cloneRoot: string | undefined,
): Promise<string> {
  if (!cloneRoot) return "";
  try {
    const mod = await import("../swarm/research/localCatalogIndex.js");
    const notes = mod.localCatalogNotesOnResearchFail(query, cloneRoot);
    return notes && notes.trim() ? `\n\n${notes.trim()}` : "";
  } catch {
    return "";
  }
}

export interface WebSearchToolOpts {
  /** Clone working tree for optional local catalog notes on total failure. */
  cloneRoot?: string;
  /** Run id for researchIntegrity / blackout accounting. */
  runId?: string;
  /** Env bag for optional API-key backends (tests). */
  env?: NodeJS.ProcessEnv;
  /** Injected fetch (tests). */
  fetchFn?: FetchLike;
  /** Skip shared rate limit (tests). */
  skipRateLimit?: boolean;
}

async function noteResearchBudgetSafe(
  kind: "attempt" | "success" | "catalog" | "failure",
  runId: string | undefined,
  failure?: { reason: string; backend?: string; http403?: boolean },
): Promise<void> {
  if (!runId) return;
  try {
    const budget = await import("../swarm/research/researchBudget.js");
    if (kind === "attempt") budget.noteResearchAttempt(runId);
    else if (kind === "success") budget.noteResearchSuccess(runId);
    else if (kind === "catalog") budget.noteCatalogInject(runId);
    else if (kind === "failure" && failure) {
      budget.noteResearchFailure(failure.reason, runId, {
        backend: failure.backend,
        http403: failure.http403,
      });
    }
  } catch {
    /* best-effort */
  }
}

export async function webSearchTool(
  args: Record<string, unknown>,
  opts?: WebSearchToolOpts,
): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  if (!query) return { ok: false, error: "web_search: query required" };
  if (query.length > 500) return { ok: false, error: "web_search: query too long" };

  const cloneRoot =
    opts?.cloneRoot ??
    (typeof args.cloneRoot === "string" ? args.cloneRoot : undefined);
  const runId =
    opts?.runId
    ?? (typeof args.runId === "string" ? args.runId : undefined);

  // RR-C local-first: strong offline catalog hit → skip DDG/API thrash.
  if (cloneRoot) {
    try {
      const { tryLocalFirstCatalog } = await import(
        "../swarm/research/localCatalogIndex.js"
      );
      const local = tryLocalFirstCatalog(query, cloneRoot);
      if (local) {
        await noteResearchBudgetSafe("catalog", runId);
        return {
          ok: true,
          output:
            `Local catalog (local-first, score=${local.bestScore}, hits=${local.hitCount}) for: ${query}\n` +
            `(no web backends queried — clone docs were sufficient)\n\n` +
            `${local.notes}\n\n` +
            `Tip: Prefer these official URLs. Use web_fetch only if you need a live page. ` +
            `Do not invent your-org / file:// placeholders.`,
        };
      }
    } catch {
      /* best-effort — fall through to web adapters */
    }
  }

  if (!opts?.skipRateLimit) {
    await applyWebRateLimit();
  }

  await noteResearchBudgetSafe("attempt", runId);

  const adapters = getSearchAdapters({
    env: opts?.env,
    fetchFn: opts?.fetchFn,
  });

  const result = await searchWithAdapters(query, adapters);
  if (result.ok) {
    await noteResearchBudgetSafe("success", runId);
    return formatSearchResults(query, result.links, result.backend);
  }

  const catalogNotes = await localCatalogFailNotes(query, cloneRoot);
  const joined = result.errors.join("; ") || "none";
  const http403 = /403/.test(joined);
  const backendMatch = joined.match(/^([a-z0-9-]+):/i);
  await noteResearchBudgetSafe("failure", runId, {
    reason: joined.slice(0, 160),
    backend: backendMatch?.[1],
    http403,
  });

  // Hard error (not soft-ok): consecutive identical failures trip toolLoopStuck
  // so the agent cannot thrash web_search for minutes (9f449937 literature loop).
  // Local catalog notes (PR4) may be appended when cloneRoot is available —
  // never invent web links.
  return {
    ok: false,
    error:
      `web_search backends unavailable for "${query}". ` +
      `Tried: ${joined}. ` +
      `Do NOT retry the same query. Use read/grep/list on the clone, or web_fetch a known official https URL ` +
      `(bis.org, worldbank.org, imf.org, fred.stlouisfed.org, data.gov). Never invent your-org/file:// placeholders.` +
      catalogNotes,
  };
}
