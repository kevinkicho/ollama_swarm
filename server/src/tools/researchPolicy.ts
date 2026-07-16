/**
 * Research tool policy gate — runs BEFORE web_fetch / web_search hit the network.
 *
 * Goal: stop the failure modes from run 9f449937 at the dispatcher boundary:
 *  - inventing placeholder GitHub URLs (your-org/your-repo)
 *  - file:// or bare repo-relative paths passed to web_fetch
 *  - thrashing web_search when the query is clearly a local path
 *
 * Returns a ready ToolResult to short-circuit dispatch, or null to proceed.
 */

export type PolicyToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

const PLACEHOLDER_HOST_RE =
  /your-org|your-repo|example\.com|example\.org|placeholder|FIXME|TODO\.com/i;

const LOCAL_PATH_RE =
  /^(?:[a-zA-Z]:[\\/]|\\\\|\/|\.\/|\.\.\/|src\/|server\/|shared\/|web\/|tests?\/|docs\/)/i;

/** True if string looks like a local filesystem / repo path, not a URL. */
export function looksLikeLocalRepoPath(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (t.startsWith("file:")) return true;
  if (LOCAL_PATH_RE.test(t)) return true;
  // extension-ish paths without scheme
  if (/\.(js|ts|tsx|jsx|mjs|cjs|json|md|css|html)$/i.test(t) && !t.includes("://")) {
    return true;
  }
  return false;
}

export function preflightWebFetch(args: Record<string, unknown>): PolicyToolResult | null {
  const url = String(args.url ?? "").trim();
  if (!url) {
    return {
      ok: false,
      error:
        "web_fetch: url required. For clone files use read/grep/list — never invent remote URLs.",
    };
  }
  if (looksLikeLocalRepoPath(url) || /^file:/i.test(url)) {
    return {
      ok: false,
      error:
        `web_fetch refused: "${url.slice(0, 120)}" looks like a local path. ` +
        `Use the read tool (or grep/list) on the clone instead of web_fetch/file://.`,
    };
  }
  if (!/^https?:\/\//i.test(url)) {
    return {
      ok: false,
      error:
        "web_fetch: valid http/https url required. " +
        "Repo paths must use read/grep/list.",
    };
  }
  if (PLACEHOLDER_HOST_RE.test(url) || /raw\.githubusercontent\.com\/your-/i.test(url)) {
    return {
      ok: false,
      error:
        "web_fetch refused: placeholder URL (your-org/example.com). " +
        "Use read for local files, or a real official https endpoint.",
    };
  }
  return null;
}

export function preflightWebSearch(args: Record<string, unknown>): PolicyToolResult | null {
  const query = String(args.query ?? "").trim();
  if (!query) {
    return { ok: false, error: "web_search: query required" };
  }
  // Model searching for a local file path — redirect to local tools.
  if (looksLikeLocalRepoPath(query) || /\bpanelRegistry\.js\b/i.test(query) && /site:github\.com/i.test(query) && /your-org|your-repo/i.test(query)) {
    return {
      ok: false,
      error:
        `web_search refused: query looks like a local/repo path or placeholder GitHub search. ` +
        `Use read/grep/list on the clone. Example: read path="src/data/panelRegistry.js".`,
    };
  }
  if (PLACEHOLDER_HOST_RE.test(query) && /github\.com|raw\.githubusercontent/i.test(query)) {
    return {
      ok: false,
      error:
        "web_search refused: placeholder github org/repo in query. Use local read tools for the clone.",
    };
  }
  return null;
}

/**
 * Policy gate for ToolDispatcher. Returns a ToolResult to return immediately,
 * or null when the call may proceed to the real implementation.
 */
export function preflightResearchTool(
  tool: string,
  args: Record<string, unknown>,
): PolicyToolResult | null {
  if (tool === "web_fetch") return preflightWebFetch(args);
  if (tool === "web_search") return preflightWebSearch(args);
  return null;
}
