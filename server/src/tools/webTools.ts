/**
 * Built-in web_fetch / web_search for research profiles.
 * Extracted from ToolDispatcher.ts.
 */

import { isBlockedWebFetchUrl } from "./ssrfGuard.js";

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

// Gov domain bias and filtering
const GOV_DOMAINS = [".gov", ".eu", ".gob", ".gov.uk", ".data.gov", ".gov.au", "worldbank.org", "oecd.org", "imf.org", "eurostat.ec.europa.eu", "un.org", "bis.org", "ecb.europa.eu", "federalreserve.gov"];
const RATE_LIMIT_MS = 2000; // simple per-process rate limit between searches
let lastWebCall = 0;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Placeholder / training-data URLs that never exist — refuse early with guidance. */
const PLACEHOLDER_HOST_RE =
  /your-org|your-repo|example\.com|example\.org|localhost|127\.0\.0\.1|0\.0\.0\.0/i;

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

  // Rate limit
  const now = Date.now();
  if (now - lastWebCall < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - (now - lastWebCall)));
  }
  lastWebCall = Date.now();

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

type SearchLink = { title: string; url: string; snippet?: string; score: number };

function scoreLink(title: string, finalUrl: string, query: string): number {
  let score = 0;
  const u = finalUrl.toLowerCase();
  if (GOV_DOMAINS.some((d) => u.includes(d))) score += 10;
  if (u.includes(".gov") || u.includes(".eu")) score += 5;
  const queryLower = query.toLowerCase();
  const words = queryLower.split(/\s+/).filter((w) => w.length > 2);
  const text = (title + " " + u).toLowerCase();
  words.forEach((w) => {
    if (text.includes(w)) score += 2;
  });
  return score;
}

function parseDdgHtml(html: string, query: string): SearchLink[] {
  const titleLinkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gi;
  const links: SearchLink[] = [];
  let match;
  while ((match = titleLinkRe.exec(html)) !== null) {
    const rawUrl = match[1];
    let title = match[2].replace(/<[^>]+>/g, "").trim();
    title = title.replace(/&amp;/g, "&").replace(/&quot;/g, '"').slice(0, 200);
    let finalUrl = rawUrl;
    const uddg = rawUrl.match(/[?&]uddg=([^&]+)/);
    if (uddg) finalUrl = decodeURIComponent(uddg[1]);
    if (!finalUrl.startsWith("http") || finalUrl.includes("duckduckgo.com")) continue;
    links.push({ title, url: finalUrl, score: scoreLink(title, finalUrl, query) });
  }
  let i = 0;
  while ((match = snippetRe.exec(html)) !== null && i < links.length) {
    let snip = match[1].replace(/<[^>]+>/g, "").trim().replace(/&amp;/g, "&");
    links[i].snippet = snip.slice(0, 300);
    i++;
  }
  return links;
}

/** Lite / alternate DDG markup used when primary HTML is blocked or empty. */
function parseDdgLiteHtml(html: string, query: string): SearchLink[] {
  const links: SearchLink[] = [];
  // lite.duckduckgo.com uses simpler anchors
  const re = /<a[^>]+rel="nofollow"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].replace(/&amp;/g, "&").trim().slice(0, 200);
    if (!url || url.includes("duckduckgo.com")) continue;
    links.push({ title, url, score: scoreLink(title, url, query) });
  }
  return links;
}

async function fetchSearchHtml(url: string): Promise<{ ok: true; html: string } | { ok: false; status: number; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, status: res.status, error: `search backend HTTP ${res.status}` };
    }
    return { ok: true, html: await res.text() };
  } catch (err: any) {
    clearTimeout(timer);
    const msg = err?.name === "AbortError" ? "timeout" : (err?.message || String(err));
    return { ok: false, status: 0, error: `web_search failed: ${msg}` };
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

export async function webSearchTool(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  if (!query) return { ok: false, error: "web_search: query required" };
  if (query.length > 500) return { ok: false, error: "web_search: query too long" };

  // Rate limit
  const now = Date.now();
  if (now - lastWebCall < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - (now - lastWebCall)));
  }
  lastWebCall = Date.now();

  const backends: Array<{
    name: string;
    url: string;
    parse: (html: string, q: string) => SearchLink[];
  }> = [
    {
      name: "duckduckgo-html",
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      parse: parseDdgHtml,
    },
    {
      name: "duckduckgo-lite",
      url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      parse: parseDdgLiteHtml,
    },
  ];

  const errors: string[] = [];
  for (const b of backends) {
    const res = await fetchSearchHtml(b.url);
    if (!res.ok) {
      errors.push(`${b.name}: ${res.error}`);
      continue;
    }
    const links = b.parse(res.html, query);
    if (links.length === 0) {
      errors.push(`${b.name}: 0 links parsed`);
      continue;
    }
    return formatSearchResults(query, links, b.name);
  }

  // Soft success with guidance so tool-loop stuck detectors don't thrash on 403 forever.
  return {
    ok: true,
    output:
      `Web search backends unavailable for "${query}".\n` +
      `Tried: ${errors.join("; ") || "none"}.\n\n` +
      `Do NOT retry web_search with the same query. Instead:\n` +
      `1. Use read/grep/list on the local clone for code and existing panels.\n` +
      `2. web_fetch known official endpoints (bis.org, worldbank.org, imf.org, fred.stlouisfed.org, data.gov, …).\n` +
      `3. Never invent placeholder URLs (your-org/your-repo, file://).`,
  };
}
