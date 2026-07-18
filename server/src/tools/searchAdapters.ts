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

/**
 * True when the query wants scholarly papers (not panel/API endpoint docs).
 * Used to lead with arXiv / OpenAlex / Crossref before DDG scrape.
 */
export function isPaperShapedQuery(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  return (
    /\b(arxiv|doi|peer[- ]reviewed|pubmed|semantic scholar|openalex|preprint|crossref)\b/i.test(q)
    || /\b(cite|citation|citations|bibliography|scholarly|academic paper|scientific paper|journal article|research paper|literature review|meta[- ]analysis|systematic review)\b/i.test(
      q,
    )
    || /\b(conference paper|proceedings|whitepaper|thesis|dissertation)\b/i.test(q)
  );
}

/** Shared academic polite-pool User-Agent (mailto for Crossref/OpenAlex etiquette). */
const ACADEMIC_UA = "ollama-swarm/1.0 (research; mailto:devnull@localhost)";

/** Free academic adapters always appended to the registry (keyless). */
export function createAcademicAdapters(fetchFn: FetchLike = fetch): SearchAdapter[] {
  return [
    createArxivAdapter(fetchFn),
    createOpenAlexAdapter(fetchFn),
    createCrossrefAdapter(fetchFn),
  ];
}

const ACADEMIC_IDS = new Set(["arxiv", "openalex", "crossref"]);

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
 * OpenAlex Works API — free scholarly catalog.
 * Optional OPENALEX_API_KEY env is appended when set; always sends polite User-Agent.
 * https://developers.openalex.org/guides/searching
 */
export function createOpenAlexAdapter(
  fetchFn: FetchLike = fetch,
  opts?: { apiKey?: string },
): SearchAdapter {
  return {
    id: "openalex",
    async search(query: string): Promise<SearchAdapterResult> {
      const params = new URLSearchParams({
        search: query,
        per_page: "8",
      });
      const key = (opts?.apiKey ?? process.env.OPENALEX_API_KEY ?? "").trim();
      if (key) params.set("api_key", key);
      const url = `https://api.openalex.org/works?${params.toString()}`;
      const res = await fetchJson(
        url,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": ACADEMIC_UA,
          },
        },
        fetchFn,
      );
      if (!res.ok) return { ok: false, error: res.error };
      const body = res.json as {
        results?: Array<{
          id?: string;
          title?: string;
          doi?: string | null;
          primary_location?: { landing_page_url?: string | null } | null;
          abstract_inverted_index?: Record<string, number[]> | null;
        }>;
      };
      const raw = body?.results ?? [];
      const links: SearchLink[] = [];
      for (const r of raw) {
        const title = String(r.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
        const landing = r.primary_location?.landing_page_url?.trim();
        const doi = r.doi?.trim();
        const doiUrl =
          doi && doi.startsWith("http")
            ? doi
            : doi
              ? `https://doi.org/${doi.replace(/^https?:\/\/doi\.org\//i, "")}`
              : "";
        const openAlexId = String(r.id ?? "").trim();
        const href =
          (landing && landing.startsWith("http") ? landing : "") ||
          doiUrl ||
          (openAlexId.startsWith("http") ? openAlexId : "");
        if (!href.startsWith("http")) continue;
        const snippet = openAlexAbstractSnippet(r.abstract_inverted_index);
        links.push({
          title: title || href,
          url: href,
          snippet,
          score: scoreLink(title || href, href, query) + 4,
        });
      }
      if (links.length === 0) return { ok: false, error: "0 links parsed" };
      return { ok: true, links };
    },
  };
}

/** Reconstruct a short snippet from OpenAlex inverted abstract index. */
export function openAlexAbstractSnippet(
  inv: Record<string, number[]> | null | undefined,
  maxChars = 300,
): string | undefined {
  if (!inv || typeof inv !== "object") return undefined;
  const positions: Array<{ word: string; i: number }> = [];
  for (const [word, idxs] of Object.entries(inv)) {
    if (!Array.isArray(idxs)) continue;
    for (const i of idxs) {
      if (typeof i === "number") positions.push({ word, i });
    }
  }
  if (positions.length === 0) return undefined;
  positions.sort((a, b) => a.i - b.i);
  const text = positions.map((p) => p.word).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + "…";
}

/**
 * Crossref Works API (keyless polite pool) — DOI / journal metadata.
 * https://api.crossref.org/works?query=...
 */
export function createCrossrefAdapter(fetchFn: FetchLike = fetch): SearchAdapter {
  return {
    id: "crossref",
    async search(query: string): Promise<SearchAdapterResult> {
      const params = new URLSearchParams({
        query,
        rows: "8",
        mailto: "devnull@localhost",
      });
      const url = `https://api.crossref.org/works?${params.toString()}`;
      const res = await fetchJson(
        url,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": ACADEMIC_UA,
          },
        },
        fetchFn,
      );
      if (!res.ok) return { ok: false, error: res.error };
      const body = res.json as {
        message?: {
          items?: Array<{
            title?: string[];
            URL?: string;
            DOI?: string;
            abstract?: string;
          }>;
        };
      };
      const raw = body?.message?.items ?? [];
      const links: SearchLink[] = [];
      for (const r of raw) {
        const title = String(r.title?.[0] ?? "")
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        const doi = (r.DOI ?? "").trim();
        const doiUrl = doi ? `https://doi.org/${doi}` : "";
        const href =
          (r.URL && r.URL.startsWith("http") ? r.URL : "") ||
          doiUrl;
        if (!href.startsWith("http")) continue;
        let snippet: string | undefined;
        if (r.abstract) {
          snippet = String(r.abstract)
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300);
        }
        links.push({
          title: title || href,
          url: href,
          snippet: snippet || undefined,
          score: scoreLink(title || href, href, query) + 4,
        });
      }
      if (links.length === 0) return { ok: false, error: "0 links parsed" };
      return { ok: true, links };
    },
  };
}

/**
 * Ordered adapter registry (RR-C adaptive).
 * - Paper-shaped: arXiv → OpenAlex → Crossref first (see searchWithAdapters)
 * - If API keys set and DDG circuit open (recent 403): keyed first, skip DDG
 * - Else: DDG HTML → lite → optional keyed → academic (arXiv/OpenAlex/Crossref)
 * - SEARCH_BACKEND=brave|serper|bing|arxiv|openalex|crossref|ddg forces preference
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

  const academic = createAcademicAdapters(fetchFn);
  const openAlexKey = (env.OPENALEX_API_KEY ?? "").trim();
  const academicWithKey = openAlexKey
    ? [
        createArxivAdapter(fetchFn),
        createOpenAlexAdapter(fetchFn, { apiKey: openAlexKey }),
        createCrossrefAdapter(fetchFn),
      ]
    : academic;

  if (force === "brave" && brave) return [createBraveAdapter(brave, fetchFn), ...ddg, ...academicWithKey];
  if (force === "serper" && serper) return [createSerperAdapter(serper, fetchFn), ...ddg, ...academicWithKey];
  if (force === "bing" && bing) return [createBingAdapter(bing, fetchFn), ...ddg, ...academicWithKey];
  if (force === "arxiv") return [createArxivAdapter(fetchFn), ...ddg, ...keyed, createOpenAlexAdapter(fetchFn, { apiKey: openAlexKey || undefined }), createCrossrefAdapter(fetchFn)];
  if (force === "openalex") {
    return [
      createOpenAlexAdapter(fetchFn, { apiKey: openAlexKey || undefined }),
      ...ddg,
      ...keyed,
      createArxivAdapter(fetchFn),
      createCrossrefAdapter(fetchFn),
    ];
  }
  if (force === "crossref") {
    return [
      createCrossrefAdapter(fetchFn),
      ...ddg,
      ...keyed,
      createArxivAdapter(fetchFn),
      createOpenAlexAdapter(fetchFn, { apiKey: openAlexKey || undefined }),
    ];
  }
  if (force === "ddg") return [...ddg, ...keyed, ...academicWithKey];

  // Prefer keyed over flaky DDG when circuit open or keys present + env PREFER_KEYED_SEARCH
  const preferKeyed =
    skipDdg ||
    (keyed.length > 0 && /^(1|true|yes)$/i.test((env.PREFER_KEYED_SEARCH ?? "").trim()));

  if (preferKeyed) return [...keyed, ...ddg, ...academicWithKey];
  return [...ddg, ...keyed, ...academicWithKey];
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
  // Paper-shaped: lead with free academic adapters (preserve injected mocks).
  let list = adapters.slice();
  if (isPaperShapedQuery(query) && !ACADEMIC_IDS.has(list[0]?.id ?? "")) {
    const academic = list.filter((a) => ACADEMIC_IDS.has(a.id));
    const rest = list.filter((a) => !ACADEMIC_IDS.has(a.id));
    if (academic.length > 0) {
      const preferred = ["arxiv", "openalex", "crossref"];
      const sorted = [
        ...preferred.flatMap((id) => academic.filter((a) => a.id === id)),
        ...academic.filter((a) => !preferred.includes(a.id)),
      ];
      list = [...sorted, ...rest];
    } else {
      list = [...createAcademicAdapters(), ...rest];
    }
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
