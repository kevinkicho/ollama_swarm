/**
 * Pluggable web_search adapters (eee6718f PR5).
 *
 * Ordered registry: DDG HTML → DDG lite → optional keyed backends when env
 * keys are set (BRAVE_API_KEY, SERPER_API_KEY, BING_SEARCH_KEY).
 * Never invents results — empty parse or HTTP failure is { ok: false }.
 */

export type SearchLink = {
  title: string;
  url: string;
  snippet?: string;
  score: number;
};

export type SearchAdapterResult =
  | { ok: true; links: SearchLink[] }
  | { ok: false; error: string };

export interface SearchAdapter {
  id: string;
  search(query: string): Promise<SearchAdapterResult>;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const SEARCH_TIMEOUT_MS = 30_000;

export const GOV_DOMAINS = [
  ".gov",
  ".eu",
  ".gob",
  ".gov.uk",
  ".data.gov",
  ".gov.au",
  "worldbank.org",
  "oecd.org",
  "imf.org",
  "eurostat.ec.europa.eu",
  "un.org",
  "bis.org",
  "ecb.europa.eu",
  "federalreserve.gov",
];

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export function scoreLink(title: string, finalUrl: string, query: string): number {
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

export function parseDdgHtml(html: string, query: string): SearchLink[] {
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
    links[i]!.snippet = snip.slice(0, 300);
    i++;
  }
  return links;
}

/** Lite / alternate DDG markup used when primary HTML is blocked or empty. */
export function parseDdgLiteHtml(html: string, query: string): SearchLink[] {
  const links: SearchLink[] = [];
  const re = /<a[^>]+rel="nofollow"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const url = match[1]!;
    const title = match[2]!.replace(/&amp;/g, "&").trim().slice(0, 200);
    if (!url || url.includes("duckduckgo.com")) continue;
    links.push({ title, url, score: scoreLink(title, url, query) });
  }
  return links;
}

export async function fetchSearchHtml(
  url: string,
  fetchFn: FetchLike = fetch,
): Promise<{ ok: true; html: string } | { ok: false; status: number; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
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
  } catch (err: unknown) {
    clearTimeout(timer);
    const e = err as { name?: string; message?: string };
    const msg = e?.name === "AbortError" ? "timeout" : (e?.message || String(err));
    return { ok: false, status: 0, error: `web_search failed: ${msg}` };
  }
}

function htmlScrapeAdapter(
  id: string,
  buildUrl: (query: string) => string,
  parse: (html: string, query: string) => SearchLink[],
  fetchFn: FetchLike,
): SearchAdapter {
  return {
    id,
    async search(query: string): Promise<SearchAdapterResult> {
      const res = await fetchSearchHtml(buildUrl(query), fetchFn);
      if (!res.ok) return { ok: false, error: res.error };
      const links = parse(res.html, query);
      if (links.length === 0) return { ok: false, error: "0 links parsed" };
      return { ok: true, links };
    },
  };
}

function createDdgHtmlAdapter(fetchFn: FetchLike = fetch): SearchAdapter {
  return htmlScrapeAdapter(
    "duckduckgo-html",
    (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parseDdgHtml,
    fetchFn,
  );
}

function createDdgLiteAdapter(fetchFn: FetchLike = fetch): SearchAdapter {
  return htmlScrapeAdapter(
    "duckduckgo-lite",
    (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    parseDdgLiteHtml,
    fetchFn,
  );
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fetchFn: FetchLike,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true, json: await res.json() };
  } catch (err: unknown) {
    clearTimeout(timer);
    const e = err as { name?: string; message?: string };
    const msg = e?.name === "AbortError" ? "timeout" : (e?.message || String(err));
    return { ok: false, error: msg };
  }
}

/** Brave Search API — https://api.search.brave.com/res/v1/web/search */
export function createBraveAdapter(
  apiKey: string,
  fetchFn: FetchLike = fetch,
): SearchAdapter {
  return {
    id: "brave",
    async search(query: string): Promise<SearchAdapterResult> {
      const url =
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
      const res = await fetchJson(
        url,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        },
        fetchFn,
      );
      if (!res.ok) return { ok: false, error: res.error };
      const body = res.json as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      const raw = body?.web?.results ?? [];
      const links: SearchLink[] = [];
      for (const r of raw) {
        const title = String(r.title ?? "").trim().slice(0, 200);
        const href = String(r.url ?? "").trim();
        if (!href.startsWith("http")) continue;
        const snippet = r.description ? String(r.description).slice(0, 300) : undefined;
        links.push({
          title: title || href,
          url: href,
          snippet,
          score: scoreLink(title || href, href, query),
        });
      }
      if (links.length === 0) return { ok: false, error: "0 links parsed" };
      return { ok: true, links };
    },
  };
}

/** Serper Google Search API — https://google.serper.dev/search */
export function createSerperAdapter(
  apiKey: string,
  fetchFn: FetchLike = fetch,
): SearchAdapter {
  return {
    id: "serper",
    async search(query: string): Promise<SearchAdapterResult> {
      const res = await fetchJson(
        "https://google.serper.dev/search",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": apiKey,
          },
          body: JSON.stringify({ q: query, num: 10 }),
        },
        fetchFn,
      );
      if (!res.ok) return { ok: false, error: res.error };
      const body = res.json as {
        organic?: Array<{ title?: string; link?: string; snippet?: string }>;
      };
      const raw = body?.organic ?? [];
      const links: SearchLink[] = [];
      for (const r of raw) {
        const title = String(r.title ?? "").trim().slice(0, 200);
        const href = String(r.link ?? "").trim();
        if (!href.startsWith("http")) continue;
        const snippet = r.snippet ? String(r.snippet).slice(0, 300) : undefined;
        links.push({
          title: title || href,
          url: href,
          snippet,
          score: scoreLink(title || href, href, query),
        });
      }
      if (links.length === 0) return { ok: false, error: "0 links parsed" };
      return { ok: true, links };
    },
  };
}

/** Bing Web Search API v7 — https://api.bing.microsoft.com/v7.0/search */
export function createBingAdapter(
  apiKey: string,
  fetchFn: FetchLike = fetch,
): SearchAdapter {
  return {
    id: "bing",
    async search(query: string): Promise<SearchAdapterResult> {
      const url =
        `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=10`;
      const res = await fetchJson(
        url,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Ocp-Apim-Subscription-Key": apiKey,
          },
        },
        fetchFn,
      );
      if (!res.ok) return { ok: false, error: res.error };
      const body = res.json as {
        webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }> };
      };
      const raw = body?.webPages?.value ?? [];
      const links: SearchLink[] = [];
      for (const r of raw) {
        const title = String(r.name ?? "").trim().slice(0, 200);
        const href = String(r.url ?? "").trim();
        if (!href.startsWith("http")) continue;
        const snippet = r.snippet ? String(r.snippet).slice(0, 300) : undefined;
        links.push({
          title: title || href,
          url: href,
          snippet,
          score: scoreLink(title || href, href, query),
        });
      }
      if (links.length === 0) return { ok: false, error: "0 links parsed" };
      return { ok: true, links };
    },
  };
}

export interface GetSearchAdaptersOpts {
  /** Env bag (defaults to process.env). Used for optional API keys. */
  env?: NodeJS.ProcessEnv;
  /** Injected fetch for tests. */
  fetchFn?: FetchLike;
  /**
   * Prefer academic adapters first (arXiv) when query looks paper-shaped.
   * Default: auto-detect from query keywords.
   */
  preferAcademic?: boolean;
}

/** Skip DDG scrapers until this time (ms epoch) after recent 403s. */
let ddgSkipUntilMs = 0;
const DDG_SKIP_MS = 10 * 60_000;

export function noteDdg403Circuit(): void {
  ddgSkipUntilMs = Date.now() + DDG_SKIP_MS;
}

export function isDdgCircuitOpen(now: number = Date.now()): boolean {
  return now < ddgSkipUntilMs;
}

/** Test helper. */
export function resetDdgCircuitForTests(): void {
  ddgSkipUntilMs = 0;
}

export function isPaperShapedQuery(query: string): boolean {
  return /\b(arxiv|doi|peer[- ]reviewed|pubmed|semantic scholar|openalex|preprint|citation|cite papers?|systematic review)\b/i.test(
    query,
  );
}

/** arXiv API (keyless) — Atom XML results. */
export function createArxivAdapter(fetchFn: FetchLike = fetch): SearchAdapter {
  return {
    id: "arxiv",
    async search(query: string): Promise<SearchAdapterResult> {
      const url =
        `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=8`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      try {
        const res = await fetchFn(url, {
          signal: controller.signal,
          headers: { Accept: "application/atom+xml" },
        });
        clearTimeout(timer);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const xml = await res.text();
        const links: SearchLink[] = [];
        const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
        let m: RegExpExecArray | null;
        while ((m = entryRe.exec(xml)) !== null) {
          const entry = m[1]!;
          const idM = /<id>([^<]+)<\/id>/.exec(entry);
          const titleM = /<title>([\s\S]*?)<\/title>/.exec(entry);
          const summaryM = /<summary>([\s\S]*?)<\/summary>/.exec(entry);
          const id = (idM?.[1] ?? "").trim();
          const title = (titleM?.[1] ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200);
          if (!id.startsWith("http")) continue;
          const absUrl = id.replace(/\/abs\//, "/abs/").replace("http://", "https://");
          const snippet = summaryM
            ? summaryM[1]!.replace(/\s+/g, " ").trim().slice(0, 300)
            : undefined;
          links.push({
            title: title || absUrl,
            url: absUrl,
            snippet,
            score: scoreLink(title || absUrl, absUrl, query) + 5,
          });
        }
        if (links.length === 0) return { ok: false, error: "0 links parsed" };
        return { ok: true, links };
      } catch (err: unknown) {
        clearTimeout(timer);
        const e = err as { name?: string; message?: string };
        const msg = e?.name === "AbortError" ? "timeout" : (e?.message || String(err));
        return { ok: false, error: msg };
      }
    },
  };
}

/**
 * Ordered adapter registry (RR-C adaptive).
 * - Paper-shaped: arXiv first
 * - If API keys set and DDG circuit open (recent 403): keyed first, skip DDG
 * - Else: DDG HTML → lite → optional keyed
 * - SEARCH_BACKEND=brave|serper|bing|ddg forces preference
 */
export function getSearchAdapters(opts?: GetSearchAdaptersOpts): SearchAdapter[] {
  const env = opts?.env ?? process.env;
  const fetchFn = opts?.fetchFn ?? fetch;
  const force = (env.SEARCH_BACKEND ?? "").trim().toLowerCase();
  const skipDdg = isDdgCircuitOpen();
  const keyed: SearchAdapter[] = [];
  const brave = (env.BRAVE_API_KEY ?? "").trim();
  if (brave) keyed.push(createBraveAdapter(brave, fetchFn));
  const serper = (env.SERPER_API_KEY ?? "").trim();
  if (serper) keyed.push(createSerperAdapter(serper, fetchFn));
  const bing = (env.BING_SEARCH_KEY ?? "").trim();
  if (bing) keyed.push(createBingAdapter(bing, fetchFn));

  const ddg: SearchAdapter[] = skipDdg
    ? []
    : [createDdgHtmlAdapter(fetchFn), createDdgLiteAdapter(fetchFn)];

  if (force === "brave" && brave) return [createBraveAdapter(brave, fetchFn), ...ddg];
  if (force === "serper" && serper) return [createSerperAdapter(serper, fetchFn), ...ddg];
  if (force === "bing" && bing) return [createBingAdapter(bing, fetchFn), ...ddg];
  if (force === "arxiv") return [createArxivAdapter(fetchFn), ...ddg, ...keyed];
  if (force === "ddg") return [...ddg, ...keyed];

  // Prefer keyed over flaky DDG when circuit open or keys present + env PREFER_KEYED_SEARCH
  const preferKeyed =
    skipDdg ||
    (keyed.length > 0 && /^(1|true|yes)$/i.test((env.PREFER_KEYED_SEARCH ?? "").trim()));

  if (preferKeyed) return [...keyed, ...ddg, createArxivAdapter(fetchFn)];
  return [...ddg, ...keyed, createArxivAdapter(fetchFn)];
}

/**
 * Try adapters in order; first success with ≥1 link wins.
 * Does not invent results. Opens DDG 403 circuit on 403 errors.
 */
export async function searchWithAdapters(
  query: string,
  adapters: SearchAdapter[],
): Promise<
  | { ok: true; links: SearchLink[]; backend: string }
  | { ok: false; errors: string[] }
> {
  // Paper-shaped: prepend arXiv if not already first
  let list = adapters.slice();
  if (isPaperShapedQuery(query) && list[0]?.id !== "arxiv") {
    list = [createArxivAdapter(), ...list.filter((a) => a.id !== "arxiv")];
  }
  const errors: string[] = [];
  for (const adapter of list) {
    try {
      const res = await adapter.search(query);
      if (!res.ok) {
        errors.push(`${adapter.id}: ${res.error}`);
        if (
          /403/.test(res.error) &&
          (adapter.id === "duckduckgo-html" || adapter.id === "duckduckgo-lite")
        ) {
          noteDdg403Circuit();
        }
        continue;
      }
      if (res.links.length === 0) {
        errors.push(`${adapter.id}: 0 links parsed`);
        continue;
      }
      return { ok: true, links: res.links, backend: adapter.id };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${adapter.id}: ${msg}`);
    }
  }
  return { ok: false, errors };
}
