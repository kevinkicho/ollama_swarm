// E3 Phase 4 (skeleton): own the tool grants opencode handles today.
// Today this dispatcher isn't wired into the providers — that's Phase 4
// part 2 (provider tool_use protocols: OpenAI tool calls / Anthropic
// tool_use blocks / Ollama function calls). This commit ships the
// foundation: profile permission tables + handlers for read/grep/glob/
// list. Bash is deliberately omitted — needs a security review against
// the existing buildCommandAllowlist.ts before it can be exposed.
//
// Profiles mirror the rules in RepoService.writeOpencodeConfig today:
//   - swarm         deny everything (workers return JSON envelopes only)
//   - swarm-read    read / grep / glob / list ALLOWED, write / edit / bash denied
//   - swarm-builder bash + read-side ALLOWED, write / edit denied
//                   (intentionally NOT shipping bash today; profile defined for
//                    completeness so Phase 4 part 2 can light it up after the
//                    bash gate is reviewed)
//
// Path safety: every read-family tool resolves through resolveSafe so a
// hallucinated `..` or absolute path can't escape the clone.

import { promises as fs } from "node:fs";
import path from "node:path";
import { exec, spawn, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { resolveSafe } from "../swarm/blackboard/resolveSafe.js";
import { checkBuildCommand } from "../swarm/blackboard/buildCommandAllowlist.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execAsync = promisify(exec);
const BASH_TIMEOUT_MS = 60_000;
const BASH_OUTPUT_CAP = 200 * 1024;

export type ToolName = "read" | "grep" | "glob" | "list" | "bash" | "write" | "edit" | "propose_hunks" | "web_fetch" | "web_search";
export type ProfileName =
  | "swarm"
  | "swarm-read"
  | "swarm-planner"
  | "swarm-builder"
  | "swarm-builder-research"
  | "swarm-write"
  | "swarm-research";
export type Permission = "allow" | "deny";

// Default tools list to advertise to the model per profile. Mirrors
// what opencode's permission system grants today. Used by chatOnce /
// promptWithRetry callers to derive `tools` for SessionProvider.chat
// without each caller having to spell out the per-profile list.
export function defaultToolsForProfile(
  profile: ProfileName,
): ReadonlyArray<"read" | "grep" | "glob" | "list" | "bash" | "propose_hunks" | "web_fetch" | "web_search"> {
  switch (profile) {
    case "swarm":
      return [];
    case "swarm-read":
      return ["read", "grep", "glob", "list"];
    case "swarm-planner":
      return ["read", "grep", "glob", "list", "web_fetch", "web_search"];
    case "swarm-builder":
      return ["read", "grep", "glob", "list", "bash"];
    case "swarm-builder-research":
      return ["read", "grep", "glob", "list", "bash", "web_fetch", "web_search"];
    case "swarm-write":
      return ["read", "grep", "glob", "list", "propose_hunks"];
    case "swarm-research":
      return ["read", "grep", "glob", "list", "web_fetch", "web_search"];
  }
}

export const PROFILES: Record<ProfileName, Record<ToolName, Permission>> = {
  swarm: {
    read: "deny",
    grep: "deny",
    glob: "deny",
    list: "deny",
    bash: "deny",
    write: "deny",
    edit: "deny",
    propose_hunks: "deny",
    web_fetch: "deny",
    web_search: "deny",
  },
  "swarm-read": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "deny",
    write: "deny",
    edit: "deny",
    propose_hunks: "deny",
    web_fetch: "deny",
    web_search: "deny",
  },
  // Blackboard planners may inspect as many repository files as needed.
  // The profile remains strictly read-only and clone-scoped; its larger
  // provider tool-turn allowance is wired by promptWithRetry.
  "swarm-planner": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "deny",
    write: "deny",
    edit: "deny",
    propose_hunks: "deny",
    web_fetch: "allow",
    web_search: "allow",
  },
  "swarm-builder": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "allow",
    write: "deny",
    edit: "deny",
    propose_hunks: "deny",
    web_fetch: "deny",
    web_search: "deny",
  },
  "swarm-builder-research": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "allow",
    write: "deny",
    edit: "deny",
    propose_hunks: "deny",
    web_fetch: "allow",
    web_search: "allow",
  },
  "swarm-write": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "deny",
    write: "deny",
    edit: "deny",
    propose_hunks: "allow",
    web_fetch: "deny",
    web_search: "deny",
  },
  // New profile for external data access (MCP-style). Opt-in via run config.
  "swarm-research": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "deny",
    write: "deny",
    edit: "deny",
    propose_hunks: "deny",
    web_fetch: "allow",
    web_search: "allow",
  },
};

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Per-tool handlers.
// ---------------------------------------------------------------------------

async function readTool(clone: string, args: Record<string, unknown>, unrestricted = false): Promise<ToolResult> {
  const p = String(args.path ?? "");
  if (!p) return { ok: false, error: "read: missing `path` arg" };
  try {
    const abs = await resolveSafe(clone, p);
    const text = await fs.readFile(abs, "utf8");
    // Cap output at 200 KB so a misclick doesn't dump a giant file
    // into the model's context.
    if (unrestricted) return { ok: true, output: text };
    const CAP = 200 * 1024;
    return { ok: true, output: text.length > CAP ? text.slice(0, CAP) + "\n…(truncated)" : text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function listTool(clone: string, args: Record<string, unknown>): Promise<ToolResult> {
  const p = String(args.path ?? ".");
  try {
    const abs = await resolveSafe(clone, p);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith(".git"))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { ok: true, output: lines.join("\n") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function globTool(clone: string, args: Record<string, unknown>, unrestricted = false): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return { ok: false, error: "glob: missing `pattern` arg" };
  // Bounded recursive walk — same shape as RepoService.listRepoFiles.
  // Glob support: only `**/<filename>` and `<dir>/<filename>` patterns
  // for the skeleton. Full minimatch comes when a real consumer needs it.
  try {
    const matches: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      const abs = rel === "" ? clone : await resolveSafe(clone, rel);
      const entries = await fs.readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".git") || (!unrestricted && e.name === "node_modules")) continue;
        const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(childRel);
        else if (matchesGlob(childRel, pattern)) matches.push(childRel);
        if (!unrestricted && matches.length >= 500) return;
      }
    };
    await walk("");
    return { ok: true, output: matches.join("\n") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Cheap glob: supports `**/<basename>`, `<dir>/<basename>`, plain `<basename>`.
// Real minimatch would be a dep we don't need yet for the skeleton.
function matchesGlob(filePath: string, pattern: string): boolean {
  if (pattern.startsWith("**/")) {
    const tail = pattern.slice(3);
    return path.basename(filePath) === tail || filePath.endsWith(`/${tail}`);
  }
  return filePath === pattern || path.basename(filePath) === pattern;
}

const MAX_GREP_PATTERN_LEN = 200;

async function grepTool(clone: string, args: Record<string, unknown>, unrestricted = false): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return { ok: false, error: "grep: missing `pattern` arg" };
  if (pattern.length > MAX_GREP_PATTERN_LEN) {
    return { ok: false, error: `grep: pattern exceeds ${MAX_GREP_PATTERN_LEN} characters` };
  }
  const subdir = String(args.path ?? ".");
  try {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return { ok: false, error: "grep: invalid regular expression" };
    }
    const root = await resolveSafe(clone, subdir);
    const hits: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".git") || (!unrestricted && e.name === "node_modules")) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) {
          try {
            const text = await fs.readFile(abs, "utf8");
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                const rel = path.relative(clone, abs).replace(/\\/g, "/");
                hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`);
                if (!unrestricted && hits.length >= 200) return;
              }
            }
          } catch {
            // skip unreadable files (binary, etc.)
          }
        }
      }
    };
    await walk(root);
    return { ok: true, output: hits.join("\n") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function bashTool(clone: string, args: Record<string, unknown>): Promise<ToolResult> {
  const command = String(args.command ?? "");
  if (!command) return { ok: false, error: "bash: missing `command` arg" };
  // Layer 1 (defense in depth): the existing buildCommandAllowlist.
  // Rejects empty cmds, shell metacharacters (;, &&, ||, |, >, <, $, `),
  // and binaries not in the curated set (npm/npx/yarn/pnpm/bun/tsc/
  // tsx/deno/eslint/prettier/biome/jest/vitest/mocha/make/task/just/
  // typedoc/jsdoc/docusaurus). Same rules opencode's swarm-builder uses.
  const allow = checkBuildCommand(command);
  if (!allow.ok) {
    return { ok: false, error: `bash refused: ${allow.reason ?? "(no reason)"}` };
  }
  // Layer 2: cwd-bound exec with a hard wall-clock timeout. cwd is the
  // clone path so working-dir-relative paths in the command resolve
  // safely. Combined with the metachar block above, the command can't
  // escape into the broader filesystem via cd /; rm or similar.
  // Note: uses shell exec (via execAsync). For stricter safety a future
  // change could switch to spawn + argv parsing, but that requires
  // careful command tokenization for the allowlisted tools.
  try {
    const r = await execAsync(command, {
      cwd: clone,
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: BASH_OUTPUT_CAP,
    });
    const out = (r.stdout ?? "") + (r.stderr ? `\n[stderr]\n${r.stderr}` : "");
    return { ok: true, output: out.length > BASH_OUTPUT_CAP ? out.slice(0, BASH_OUTPUT_CAP) + "\n…(truncated)" : out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    const stdout = (e.stdout ?? "").toString();
    const stderr = (e.stderr ?? "").toString();
    const detail = stderr.trim() || stdout.trim() || (e.message ?? "exec failed");
    if (e.killed) {
      return { ok: false, error: `bash killed after ${Math.round(BASH_TIMEOUT_MS / 1000)}s timeout: ${detail.slice(-500)}` };
    }
    return { ok: false, error: `bash exited non-zero: ${detail.slice(-700)}` };
  }
}

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

async function webFetchTool(args: Record<string, unknown>): Promise<ToolResult> {
  const url = String(args.url ?? "").trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: "web_fetch: valid http/https url required" };
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

async function webSearchTool(args: Record<string, unknown>): Promise<ToolResult> {
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

// ---------------------------------------------------------------------------
// Dispatcher.
// ---------------------------------------------------------------------------

export class ToolDispatcher {
  private mcpClients: Map<string, { client: Client; transport: StdioClientTransport; proc?: ChildProcess }> = new Map();
  private mcpToolToClient: Map<string, string> = new Map(); // toolName -> clientKey

  constructor(
    private readonly profile: ProfileName,
    private readonly clonePath: string,
    mcpServers?: string,
  ) {
    if (
      mcpServers
      && (profile === "swarm-research"
        || profile === "swarm-read"
        || profile === "swarm-planner"
        || profile === "swarm-builder-research")
    ) {
      // Fire and forget for now; in real use await initMcpServers
      this.initMcpServers(mcpServers).catch((e) => console.error("MCP init failed", e));
    }
  }

  private async initMcpServers(mcpServers: string) {
    const specs = mcpServers.split(/[\s,]+/).filter(Boolean);
    for (const spec of specs) {
      const eq = spec.indexOf("=");
      if (eq === -1) continue;
      const key = spec.slice(0, eq).trim();
      const cmdStr = spec.slice(eq + 1).trim();
      if (!key || !cmdStr) continue;
      try {
        // Simple parse: first word command, rest args (improve with shell parse if needed)
        const parts = cmdStr.split(/\s+/);
        const command = parts[0];
        const args = parts.slice(1);

        // Example for real MCP server spawn:
        // Free keyless search: mcpServers="search=npx -y open-websearch@latest"
        // (multi-engine: DuckDuckGo, Bing, etc. — no API key).
        // Other: "fetch=npx -y @modelcontextprotocol/server-fetch"
        // The SDK handles the stdio transport and tool listing/calling.
        const isWin = process.platform === "win32";
        const transport = new StdioClientTransport({
          command,
          args,
          ...(isWin ? { shell: true } : {}),
        });
        const client = new Client(
          { name: `swarm-mcp-${key}`, version: "0.1.0" },
          { capabilities: {} }
        );
        await client.connect(transport);

        // To support kill, we can leave proc undefined or enhance transport if needed.
        this.mcpClients.set(key, { client, transport });
        // List tools and register (namespaced to avoid collision with native)
        const toolsResp = await client.listTools();
        for (const t of toolsResp.tools || []) {
          const toolName = `${key}:${t.name}`;
          this.mcpToolToClient.set(toolName, key);
          if (!this.mcpToolToClient.has(t.name)) {
            this.mcpToolToClient.set(t.name, key);
          }
        }
        const toolNames = toolsResp.tools?.map(t => t.name) || [];
        console.log(`[MCP] Connected server "${key}" with tools:`, toolNames);

        // Auto-detection / friendly message for common free search MCPs
        const isSearchServer = key.toLowerCase().includes("search") || toolNames.some(n => /search|web_search/i.test(n));
        if (isSearchServer) {
          console.log(`[MCP] Free keyless search server "${key}" connected. This augments the built-in DuckDuckGo web_search (no MCP config required for native version).`);
        }
      } catch (e: any) {
        const msg = e?.message || String(e);
        console.error(`[MCP] Failed to spawn/connect "${key}": ${msg}`);
        if (key.toLowerCase().includes("search") || cmdStr.includes("open-websearch") || cmdStr.includes("heventure")) {
          console.warn(`[MCP] Tip for free search: try "search=npx -y open-websearch@latest" (Node) or "search=uvx heventure-search-mcp" (Python). Ensure npx/uv is in PATH. Native DuckDuckGo web_search is available without MCP.`);
        }
      }
    }
  }

  async closeMcp() {
    for (const [key, entry] of this.mcpClients) {
      try {
        await entry.client.close();
        // proc kill if we captured it in future enhancements
      } catch {}
    }
    this.mcpClients.clear();
    this.mcpToolToClient.clear();
  }

  async dispatch(call: ToolCall): Promise<ToolResult> {
    const perm = PROFILES[this.profile][call.tool];
    if (perm !== "allow") {
      // Check if it's an MCP tool (namespaced or direct)
      const mcpKey = this.mcpToolToClient.get(call.tool) || this.mcpToolToClient.get(`${call.tool}`);
      if (mcpKey && this.mcpClients.has(mcpKey)) {
        return this.callMcpTool(mcpKey, call.tool, call.args);
      }
      return {
        ok: false,
        error: `tool "${call.tool}" denied by profile "${this.profile}"`,
      };
    }
    switch (call.tool) {
      case "read":
        return readTool(this.clonePath, call.args, this.profile === "swarm-planner");
      case "list":
        return listTool(this.clonePath, call.args);
      case "glob":
        return globTool(this.clonePath, call.args, this.profile === "swarm-planner");
      case "grep":
        return grepTool(this.clonePath, call.args, this.profile === "swarm-planner");
      case "bash":
        return bashTool(this.clonePath, call.args);
      case "propose_hunks":
        // Phase 2 (writeMode: multi): agent proposes hunks during turn.
        // The dispatcher doesn't apply them — just returns the envelope
        // for the runner to collect and reconcile.
        return {
          ok: true,
          output: JSON.stringify({
            note: "propose_hunks tool called — return hunks in your response",
            format: { hunks: "Hunk[]", skip: "string (optional)" },
          }),
        };
      case "write":
      case "edit":
        // No profile allows these today; if we ever change that, the
        // PROFILES table above is the single source of truth.
        return { ok: false, error: `${call.tool} dispatch not yet implemented` };
      case "web_fetch":
        return webFetchTool(call.args);
      case "web_search":
        return webSearchTool(call.args);
      default:
        // Try as MCP tool (direct name)
        const mcpKey2 = this.mcpToolToClient.get(call.tool);
        if (mcpKey2 && this.mcpClients.has(mcpKey2)) {
          return this.callMcpTool(mcpKey2, call.tool, call.args);
        }
        return { ok: false, error: `unknown tool ${call.tool}` };
    }
  }

  private async callMcpTool(clientKey: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.mcpClients.get(clientKey);
    if (!entry) return { ok: false, error: "MCP client not found" };
    try {
      // Strip namespace if present
      const actualName = toolName.includes(":") ? toolName.split(":")[1] : toolName;
      const result = await entry.client.callTool({
        name: actualName,
        arguments: args,
      });
      const output = typeof result.content === "string" ? result.content : JSON.stringify(result.content || result);
      return { ok: true, output: String(output).slice(0, 100 * 1024) };
    } catch (e: any) {
      return { ok: false, error: `MCP call failed: ${e?.message || e}` };
    }
  }
}
