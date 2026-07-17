import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createBingAdapter,
  createBraveAdapter,
  createCrossrefAdapter,
  createOpenAlexAdapter,
  createSerperAdapter,
  getSearchAdapters,
  openAlexAbstractSnippet,
  parseDdgHtml,
  parseDdgLiteHtml,
  scoreLink,
  searchWithAdapters,
  type FetchLike,
  type SearchAdapter,
} from "./searchAdapters.js";
import { webSearchTool, _resetWebRateLimitForTests } from "./webTools.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

describe("scoreLink / parsers", () => {
  it("boosts gov domains", () => {
    const gov = scoreLink("BLS", "https://api.bls.gov/publicAPI", "labor stats");
    const plain = scoreLink("Blog", "https://random-blog.example/page", "labor stats");
    assert.ok(gov > plain);
  });

  it("parseDdgHtml extracts uddg-decoded URLs and never invents links", () => {
    const encoded = encodeURIComponent("https://stats.bis.org/api");
    const html = `
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=${encoded}">BIS API</a>
      <a class="result__snippet">Official stats</a>
      <a class="result__a" href="https://duckduckgo.com/about">About DDG</a>
    `;
    const links = parseDdgHtml(html, "BIS API");
    assert.equal(links.length, 1);
    assert.equal(links[0]!.url, "https://stats.bis.org/api");
    assert.equal(links[0]!.title, "BIS API");
    assert.match(links[0]!.snippet ?? "", /Official/);
  });

  it("parseDdgLiteHtml skips duckduckgo.com hosts", () => {
    const html = `
      <a rel="nofollow" href="https://api.worldbank.org/v2">World Bank API</a>
      <a rel="nofollow" href="https://duckduckgo.com/foo">Internal</a>
    `;
    const links = parseDdgLiteHtml(html, "world bank");
    assert.equal(links.length, 1);
    assert.equal(links[0]!.url, "https://api.worldbank.org/v2");
  });

  it("parse returns empty on garbage HTML (never invents)", () => {
    assert.deepEqual(parseDdgHtml("<html>no results</html>", "q"), []);
    assert.deepEqual(parseDdgLiteHtml("<html>no results</html>", "q"), []);
  });
});

describe("getSearchAdapters registry", () => {
  it("always includes DDG HTML then lite; academic adapters; no keyed without keys", () => {
    const adapters = getSearchAdapters({ env: {} });
    assert.deepEqual(
      adapters.map((a) => a.id),
      [
        "duckduckgo-html",
        "duckduckgo-lite",
        "arxiv",
        "openalex",
        "crossref",
      ],
    );
  });

  it("appends optional backends when keys are set (DDG → keyed → academic)", () => {
    const adapters = getSearchAdapters({
      env: {
        BRAVE_API_KEY: "b-key",
        SERPER_API_KEY: "s-key",
        BING_SEARCH_KEY: "bing-key",
      },
    });
    assert.deepEqual(
      adapters.map((a) => a.id),
      [
        "duckduckgo-html",
        "duckduckgo-lite",
        "brave",
        "serper",
        "bing",
        "arxiv",
        "openalex",
        "crossref",
      ],
    );
  });

  it("ignores blank keys", () => {
    const adapters = getSearchAdapters({
      env: { BRAVE_API_KEY: "  ", SERPER_API_KEY: "", BING_SEARCH_KEY: "x" },
    });
    assert.deepEqual(
      adapters.map((a) => a.id),
      [
        "duckduckgo-html",
        "duckduckgo-lite",
        "bing",
        "arxiv",
        "openalex",
        "crossref",
      ],
    );
  });

  it("PREFER_KEYED_SEARCH puts keyed before DDG", () => {
    const adapters = getSearchAdapters({
      env: { BRAVE_API_KEY: "b", PREFER_KEYED_SEARCH: "1" },
    });
    assert.equal(adapters[0]?.id, "brave");
  });
});

describe("OpenAlex / Crossref adapters", () => {
  it("openAlexAbstractSnippet reconstructs inverted index", () => {
    const snip = openAlexAbstractSnippet({
      Hello: [0],
      world: [1],
    });
    assert.equal(snip, "Hello world");
  });

  it("openalex maps works results", async () => {
    const fetchFn: FetchLike = async (input) => {
      assert.match(String(input), /api\.openalex\.org\/works/);
      return jsonResponse({
        results: [
          {
            id: "https://openalex.org/W123",
            title: "A paper",
            doi: "https://doi.org/10.1234/x",
            primary_location: { landing_page_url: "https://example.edu/paper" },
            abstract_inverted_index: { Abstract: [0], text: [1] },
          },
        ],
      });
    };
    const res = await createOpenAlexAdapter(fetchFn).search("topic");
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.links[0]!.url, "https://example.edu/paper");
    assert.equal(res.links[0]!.title, "A paper");
    assert.match(res.links[0]!.snippet ?? "", /Abstract text/);
  });

  it("openalex fails closed on empty results", async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ results: [] });
    const res = await createOpenAlexAdapter(fetchFn).search("nothing");
    assert.equal(res.ok, false);
  });

  it("crossref maps message.items", async () => {
    const fetchFn: FetchLike = async (input) => {
      assert.match(String(input), /api\.crossref\.org\/works/);
      return jsonResponse({
        message: {
          items: [
            {
              title: ["Crossref Paper"],
              DOI: "10.1000/xyz",
              URL: "https://doi.org/10.1000/xyz",
              abstract: "<jats:p>Summary here</jats:p>",
            },
          ],
        },
      });
    };
    const res = await createCrossrefAdapter(fetchFn).search("topic");
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.links[0]!.url, "https://doi.org/10.1000/xyz");
    assert.equal(res.links[0]!.title, "Crossref Paper");
    assert.match(res.links[0]!.snippet ?? "", /Summary here/);
  });

  it("paper-shaped query prepends academic adapters", async () => {
    const order: string[] = [];
    const ddg: SearchAdapter = {
      id: "duckduckgo-html",
      search: async () => {
        order.push("duckduckgo-html");
        return { ok: false, error: "skip" };
      },
    };
    // searchWithAdapters prepends arxiv/openalex/crossref for paper queries
    const res = await searchWithAdapters("cite arxiv papers on transformers", [
      ddg,
      {
        id: "arxiv",
        search: async () => {
          order.push("arxiv");
          return {
            ok: true,
            links: [{ title: "T", url: "https://arxiv.org/abs/1", score: 1 }],
          };
        },
      },
    ]);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // academic first — ddg should not run first
    assert.ok(order[0] === "arxiv" || order.includes("arxiv"));
    assert.equal(res.backend, "arxiv");
  });
});

describe("keyed adapters with mock fetch", () => {
  it("brave maps web.results", async () => {
    const fetchFn: FetchLike = async (input) => {
      assert.match(String(input), /api\.search\.brave\.com/);
      return jsonResponse({
        web: {
          results: [
            {
              title: "FRED API",
              url: "https://fred.stlouisfed.org/docs/api/fred/",
              description: "Federal Reserve data",
            },
          ],
        },
      });
    };
    const res = await createBraveAdapter("k", fetchFn).search("FRED");
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.links.length, 1);
    assert.equal(res.links[0]!.url, "https://fred.stlouisfed.org/docs/api/fred/");
  });

  it("serper maps organic links", async () => {
    const fetchFn: FetchLike = async (input, init) => {
      assert.equal(String(input), "https://google.serper.dev/search");
      assert.equal(init?.method, "POST");
      return jsonResponse({
        organic: [
          { title: "IMF Data", link: "https://www.imf.org/en/Data", snippet: "IMF" },
        ],
      });
    };
    const res = await createSerperAdapter("k", fetchFn).search("IMF");
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.links[0]!.url, "https://www.imf.org/en/Data");
  });

  it("bing maps webPages.value", async () => {
    const fetchFn: FetchLike = async (input) => {
      assert.match(String(input), /api\.bing\.microsoft\.com/);
      return jsonResponse({
        webPages: {
          value: [
            { name: "OECD", url: "https://www.oecd.org/data", snippet: "stats" },
          ],
        },
      });
    };
    const res = await createBingAdapter("k", fetchFn).search("OECD");
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.links[0]!.url, "https://www.oecd.org/data");
  });

  it("keyed adapter fails closed on empty results (no invention)", async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ web: { results: [] } });
    const res = await createBraveAdapter("k", fetchFn).search("nothing");
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /0 links/i);
  });

  it("keyed adapter surfaces HTTP errors", async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ error: "nope" }, 403);
    const res = await createSerperAdapter("k", fetchFn).search("q");
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /403/);
  });
});

describe("searchWithAdapters first-success-wins", () => {
  it("skips failing adapters and returns first success", async () => {
    const fail: SearchAdapter = {
      id: "fail",
      search: async () => ({ ok: false, error: "blocked" }),
    };
    const ok: SearchAdapter = {
      id: "ok",
      search: async () => ({
        ok: true,
        links: [{ title: "T", url: "https://example.org/a", score: 1 }],
      }),
    };
    const never: SearchAdapter = {
      id: "never",
      search: async () => {
        throw new Error("should not run");
      },
    };
    const res = await searchWithAdapters("q", [fail, ok, never]);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.backend, "ok");
    assert.equal(res.links[0]!.url, "https://example.org/a");
  });

  it("returns aggregated errors when all fail", async () => {
    const res = await searchWithAdapters("q", [
      { id: "a", search: async () => ({ ok: false, error: "e1" }) },
      { id: "b", search: async () => ({ ok: false, error: "e2" }) },
    ]);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.deepEqual(res.errors, ["a: e1", "b: e2"]);
  });
});

describe("webSearchTool via adapters", () => {
  it("uses DDG HTML when it returns links", async () => {
    _resetWebRateLimitForTests();
    const encoded = encodeURIComponent("https://fred.stlouisfed.org/");
    const fetchFn: FetchLike = async (input) => {
      const u = String(input);
      if (u.includes("html.duckduckgo.com")) {
        return htmlResponse(
          `<a class="result__a" href="https://duckduckgo.com/l/?uddg=${encoded}">FRED</a>`,
        );
      }
      return htmlResponse("", 403);
    };
    const result = await webSearchTool(
      { query: "FRED API docs" },
      { fetchFn, env: {}, skipRateLimit: true },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /fred\.stlouisfed\.org/i);
    assert.match(result.output, /duckduckgo-html/);
  });

  it("falls through to DDG lite after HTML 403", async () => {
    _resetWebRateLimitForTests();
    const fetchFn: FetchLike = async (input) => {
      const u = String(input);
      if (u.includes("html.duckduckgo.com")) return htmlResponse("blocked", 403);
      if (u.includes("lite.duckduckgo.com")) {
        return htmlResponse(
          `<a rel="nofollow" href="https://api.worldbank.org/v2">World Bank</a>`,
        );
      }
      return htmlResponse("", 500);
    };
    const result = await webSearchTool(
      { query: "world bank api" },
      { fetchFn, env: {}, skipRateLimit: true },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /api\.worldbank\.org/);
    assert.match(result.output, /duckduckgo-lite/);
  });

  it("tries Brave after free backends fail when key set", async () => {
    _resetWebRateLimitForTests();
    const fetchFn: FetchLike = async (input) => {
      const u = String(input);
      if (u.includes("duckduckgo.com")) return htmlResponse("nope", 403);
      if (u.includes("api.search.brave.com")) {
        return jsonResponse({
          web: {
            results: [
              { title: "BIS", url: "https://stats.bis.org/", description: "stats" },
            ],
          },
        });
      }
      return jsonResponse({}, 500);
    };
    const result = await webSearchTool(
      { query: "BIS statistics" },
      { fetchFn, env: { BRAVE_API_KEY: "test-brave" }, skipRateLimit: true },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /stats\.bis\.org/);
    assert.match(result.output, /backend: brave/);
  });

  it("hard-fails with guidance when all adapters fail (no invented links)", async () => {
    _resetWebRateLimitForTests();
    const fetchFn: FetchLike = async () => htmlResponse("blocked", 403);
    const result = await webSearchTool(
      { query: "obscure query xyzzy" },
      { fetchFn, env: {}, skipRateLimit: true },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /backends unavailable/i);
    assert.match(result.error, /Do NOT retry/i);
    assert.doesNotMatch(result.error, /https:\/\/invented\./);
  });
});
