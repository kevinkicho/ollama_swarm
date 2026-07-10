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
const GOV_DOMAINS = [".gov", ".eu", ".gob", ".gov.uk", ".data.gov", ".gov.au", "worldbank.org", "oecd.org", "imf.org", "eurostat.ec.europa.eu", "un.org"];
const RATE_LIMIT_MS = 2000; // simple per-process rate limit between searches
let lastWebCall = 0;

export async function webFetchTool(args: Record<string, unknown>): Promise<ToolResult> {
  const url = String(args.url ?? "").trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: "web_fetch: valid http/https url required" };
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
        mainContent = containerMatch[1] || containerMatch[3] || containerMatch[4] || containerMatch[0];
      } else {
        // Fallback: strip noise tags, try to grab body content.
        mainContent = rawText.replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<nav[\s\S]*?<\/nav>/gi, "")
          .replace(/<header[\s\S]*?<\/header>/gi, "")
          .replace(/<footer[\s\S]*?<\/footer>/gi, "")
          .replace(/<aside[\s\S]*?<\/aside>/gi, "");
        // Try to extract from <body> if present.
        const bodyMatch = mainContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyMatch) mainContent = bodyMatch[1];
      }

      // Strip remaining tags, normalize whitespace, cap.
      mainContent = mainContent.replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 8000);  // slightly larger cap for richer research pages
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

export async function webSearchTool(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  if (!query) return { ok: false, error: "web_search: query required" };
  if (query.length > 500) return { ok: false, error: "web_search: query too long" };

  // Rate limit
  const now = Date.now();
  if (now - lastWebCall < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - (now - lastWebCall)));
  }
  lastWebCall = Date.now();

  // Use DuckDuckGo HTML (no API key).
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
    const res = await fetch(ddgUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ollama-swarm-research/1.0)",
        "Accept": "text/html",
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, error: `search backend HTTP ${res.status}` };
    }

    const html = await res.text();

    // Improved lightweight extraction for DDG HTML results.
    const results: string[] = [];
    const titleLinkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gi;

    let match;
    const links: Array<{ title: string; url: string; snippet?: string; score: number }> = [];

    // Collect links
    while ((match = titleLinkRe.exec(html)) !== null) {
      const rawUrl = match[1];
      let title = match[2].replace(/<[^>]+>/g, "").trim();
      title = title.replace(/&amp;/g, '&').replace(/&quot;/g, '"').slice(0, 200);
      let finalUrl = rawUrl;
      const uddg = rawUrl.match(/[?&]uddg=([^&]+)/);
      if (uddg) finalUrl = decodeURIComponent(uddg[1]);
      if (!finalUrl.startsWith('http') || finalUrl.includes('duckduckgo.com')) continue;
      // Score for gov bias + relevance to query
      let score = 0;
      const u = finalUrl.toLowerCase();
      if (GOV_DOMAINS.some(d => u.includes(d))) score += 10;
      if (u.includes('.gov') || u.includes('.eu')) score += 5;
      // simple relevance: count query words in title/url
      const queryLower = query.toLowerCase();
      const words = queryLower.split(/\s+/).filter(w => w.length > 2);
      const text = (title + ' ' + u).toLowerCase();
      words.forEach(w => { if (text.includes(w)) score += 2; });
      links.push({ title, url: finalUrl, score });
    }

    // Pair snippets
    let i = 0;
    while ((match = snippetRe.exec(html)) !== null && i < links.length) {
      let snip = match[1].replace(/<[^>]+>/g, "").trim().replace(/&amp;/g, '&');
      links[i].snippet = snip.slice(0, 300);
      i++;
    }

    // Rank: gov first, then original order
    links.sort((a, b) => b.score - a.score);

    // Additional gov-domain filtering / bias if query seems research/gov related
    const queryLower = query.toLowerCase();
    const isGovQuery = /gov|governmental|government|official|data endpoint|api/i.test(queryLower);
    let filteredLinks = links;
    if (isGovQuery) {
      filteredLinks = links.filter(l => GOV_DOMAINS.some(d => l.url.toLowerCase().includes(d)) || l.url.toLowerCase().includes('.gov') || l.url.toLowerCase().includes('.eu'));
      if (filteredLinks.length === 0) filteredLinks = links; // fallback
    }

    for (const r of filteredLinks.slice(0, 10)) {
      let entry = `Result:\n  Title: ${r.title}\n  URL: ${r.url}`;
      if (r.snippet) entry += `\n  Snippet: ${r.snippet}`;
      entry += `\n  RelevanceScore: ${r.score}`;
      if (GOV_DOMAINS.some(d => r.url.toLowerCase().includes(d)) || r.url.toLowerCase().includes('.gov') || r.url.toLowerCase().includes('.eu')) {
        entry += ` (Official/Gov source)`;
      }
      results.push(entry);
    }

    if (results.length === 0) {
      return { ok: true, output: `Search for "${query}" performed. No structured results extracted (try web_fetch on a specific URL).` };
    }

    return {
      ok: true,
      output: `Web search results for: ${query}\n\n${results.join("\n\n")}\n\nTip for research: Use web_fetch on the most relevant URLs above to get full details.`,
    };
  } catch (err: any) {
    const msg = err?.name === "AbortError" ? "timeout" : (err?.message || String(err));
    return { ok: false, error: `web_search failed: ${msg}` };
  }
}

