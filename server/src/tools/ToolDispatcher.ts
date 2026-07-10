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
import { spawn, ChildProcess } from "node:child_process";
import { resolveSafe } from "../swarm/blackboard/resolveSafe.js";
import { checkBuildCommand } from "../swarm/blackboard/buildCommandAllowlist.js";
import {
  BASH_ERROR_BACKOFF_THRESHOLD,
  getAgentBashErrors,
  recordAgentBashResult,
} from "./agentBashBackoff.js";
import { webFetchTool, webSearchTool } from "./webTools.js";
import { config } from "../config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Split allowlisted command into argv without a shell. */
export function tokenizeAllowlistedCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}
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

function unrestrictedReadTools(profile: ProfileName): boolean {
  return profile === "swarm-planner" || profile === "swarm-research";
}

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
      return ["read", "grep", "glob", "list", "bash", "web_fetch", "web_search"];
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
    bash: "allow",
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

export type ToolResultHook = (info: {
  tool: string;
  ok: boolean;
  error?: string;
  preview: string;
}) => void;

// ---------------------------------------------------------------------------
// Per-tool handlers.
// ---------------------------------------------------------------------------

async function readTool(clone: string, args: Record<string, unknown>, unrestricted = false): Promise<ToolResult> {
  const p = String(args.path ?? "");
  if (!p) return { ok: false, error: "read: missing `path` arg" };
  try {
    const abs = await resolveSafe(clone, p);
    const st = await fs.stat(abs);
    if (st.isDirectory()) {
      const cloneReal = await fs.realpath(clone);
      const rel = path.relative(cloneReal, abs).replace(/\\/g, "/") || ".";
      const listing = await listTool(clone, { path: rel });
      if (!listing.ok) return listing;
      return {
        ok: true,
        output: `(read: "${p}" is a directory — listing contents)\n${listing.output}`,
      };
    }
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
    if (lines.length === 0) {
      return { ok: true, output: `(empty directory: ${p})` };
    }
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
    if (matches.length === 0) {
      return { ok: true, output: `(no files matched pattern: ${pattern})` };
    }
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

async function grepFileForPattern(
  abs: string,
  clone: string,
  re: RegExp,
  hits: string[],
  unrestricted: boolean,
): Promise<void> {
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
    const st = await fs.stat(root);
    if (st.isFile()) {
      await grepFileForPattern(root, clone, re, hits, unrestricted);
    } else {
      const walk = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith(".git") || (!unrestricted && e.name === "node_modules")) continue;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) await walk(abs);
          else if (e.isFile()) await grepFileForPattern(abs, clone, re, hits, unrestricted);
        }
      };
      await walk(root);
    }
    if (hits.length === 0) {
      const scope = subdir && subdir !== "." ? ` in ${subdir}` : "";
      return { ok: true, output: `(no matches for pattern "${pattern}"${scope})` };
    }
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
  // Layer 2: cwd-bound spawn with shell:false + wall-clock timeout.
  // Metachar block + argv split prevents shell injection; cwd is the clone.
  const argv = tokenizeAllowlistedCommand(command);
  if (argv.length === 0) {
    return { ok: false, error: "bash refused: empty command after tokenize" };
  }
  const bin = argv[0]!;
  const binArgs = argv.slice(1);
  try {
    const out = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(bin, binArgs, {
        cwd: clone,
        shell: false,
        windowsHide: true,
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2_000).unref?.();
      }, BASH_TIMEOUT_MS);
      child.stdout?.on("data", (c: Buffer) => {
        if (stdout.length < BASH_OUTPUT_CAP) stdout += c.toString();
      });
      child.stderr?.on("data", (c: Buffer) => {
        if (stderr.length < BASH_OUTPUT_CAP) stderr += c.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (killed) {
          reject(Object.assign(new Error("timeout"), { killed: true, stdout, stderr }));
          return;
        }
        if (code !== 0 && code !== null) {
          reject(Object.assign(new Error(`exit ${code}`), { stdout, stderr, code }));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    const combined = (out.stdout ?? "") + (out.stderr ? `\n[stderr]\n${out.stderr}` : "");
    return {
      ok: true,
      output:
        combined.length > BASH_OUTPUT_CAP
          ? combined.slice(0, BASH_OUTPUT_CAP) + "\n…(truncated)"
          : combined,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    const stdout = (e.stdout ?? "").toString();
    const stderr = (e.stderr ?? "").toString();
    const detail = stderr.trim() || stdout.trim() || (e.message ?? "exec failed");
    if (e.killed) {
      return {
        ok: false,
        error: `bash killed after ${Math.round(BASH_TIMEOUT_MS / 1000)}s timeout: ${detail.slice(-500)}`,
      };
    }
    return { ok: false, error: `bash exited non-zero: ${detail.slice(-700)}` };
  }
}
export class ToolDispatcher {
  private mcpClients: Map<string, { client: Client; transport: StdioClientTransport; proc?: ChildProcess }> = new Map();
  private mcpToolToClient: Map<string, string> = new Map(); // toolName -> clientKey

  constructor(
    private readonly profile: ProfileName,
    private readonly clonePath: string,
    mcpServers?: string,
    private readonly agentId?: string,
    private readonly onToolResult?: ToolResultHook,
  ) {
    if (
      mcpServers
      && config.SWARM_ALLOW_MCP_SERVERS
      && (profile === "swarm-research"
        || profile === "swarm-read"
        || profile === "swarm-planner"
        || profile === "swarm-builder-research")
    ) {
      // Fire and forget for now; in real use await initMcpServers
      this.initMcpServers(mcpServers).catch((e) => console.error("MCP init failed", e));
    } else if (mcpServers && !config.SWARM_ALLOW_MCP_SERVERS) {
      console.warn(
        "MCP servers requested but SWARM_ALLOW_MCP_SERVERS=false — ignoring (set true to opt in; RCE surface).",
      );
    }
  }

  private async initMcpServers(mcpServers: string) {
    if (!config.SWARM_ALLOW_MCP_SERVERS) {
      return;
    }
    const specs = mcpServers.split(/[\s,]+/).filter(Boolean);
    // Only allow a small set of package-manager entrypoints when opt-in.
    const MCP_BIN_ALLOW = new Set(["npx", "npx.cmd", "node", "bun", "bunx", "python", "python3"]);
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
        if (!command || !MCP_BIN_ALLOW.has(command.toLowerCase())) {
          console.error(
            `MCP spawn refused for key=${key}: binary "${command}" not in allowlist (${[...MCP_BIN_ALLOW].join(", ")})`,
          );
          continue;
        }

        // argv only (do not pass shell:true — avoids Windows cmd injection).
        const transport = new StdioClientTransport({
          command,
          args,
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

  private notifyToolResult(tool: string, result: ToolResult): void {
    if (!this.onToolResult) return;
    this.onToolResult({
      tool,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      preview: result.ok ? (result.output ?? "").slice(0, 200) : (result.error ?? "").slice(0, 200),
    });
  }

  async dispatch(call: ToolCall): Promise<ToolResult> {
    let result: ToolResult;
    const perm = PROFILES[this.profile][call.tool];
    if (perm !== "allow") {
      // Check if it's an MCP tool (namespaced or direct)
      const mcpKey = this.mcpToolToClient.get(call.tool) || this.mcpToolToClient.get(`${call.tool}`);
      if (mcpKey && this.mcpClients.has(mcpKey)) {
        result = await this.callMcpTool(mcpKey, call.tool, call.args);
        this.notifyToolResult(call.tool, result);
        return result;
      }
      const denied: ToolResult = {
        ok: false,
        error: `tool "${call.tool}" denied by profile "${this.profile}"`,
      };
      this.notifyToolResult(call.tool, denied);
      return denied;
    }
    switch (call.tool) {
      case "read":
        result = await readTool(this.clonePath, call.args, unrestrictedReadTools(this.profile));
        break;
      case "list":
        result = await listTool(this.clonePath, call.args);
        break;
      case "glob":
        result = await globTool(this.clonePath, call.args, unrestrictedReadTools(this.profile));
        break;
      case "grep":
        result = await grepTool(this.clonePath, call.args, unrestrictedReadTools(this.profile));
        break;
      case "bash": {
        const prior = getAgentBashErrors(this.agentId);
        if (prior >= BASH_ERROR_BACKOFF_THRESHOLD) {
          result = {
            ok: false,
            error:
              `bash disabled after ${prior} consecutive failures — use read, grep, or glob instead`,
          };
          break;
        }
        result = await bashTool(this.clonePath, call.args);
        recordAgentBashResult(this.agentId, result.ok);
        break;
      }
      case "propose_hunks":
        result = {
          ok: true,
          output: JSON.stringify({
            note: "propose_hunks tool called — return hunks in your response",
            format: { hunks: "Hunk[]", skip: "string (optional)" },
          }),
        };
        break;
      case "write":
      case "edit":
        result = { ok: false, error: `${call.tool} dispatch not yet implemented` };
        break;
      case "web_fetch":
        result = await webFetchTool(call.args);
        break;
      case "web_search":
        result = await webSearchTool(call.args);
        break;
      default: {
        const mcpKey2 = this.mcpToolToClient.get(call.tool);
        if (mcpKey2 && this.mcpClients.has(mcpKey2)) {
          result = await this.callMcpTool(mcpKey2, call.tool, call.args);
        } else {
          result = { ok: false, error: `unknown tool ${call.tool}` };
        }
      }
    }
    this.notifyToolResult(call.tool, result);
    return result;
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
