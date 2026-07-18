// E3 Phase 4: tool grants + native handlers + optional MCP.
// Handlers live in nativeToolHandlers; profiles in toolDispatchProfiles.

import type { ChildProcess } from "node:child_process";
import {
  BASH_ERROR_BACKOFF_THRESHOLD,
  getAgentBashErrors,
  recordAgentBashResult,
} from "./agentBashBackoff.js";
import { webFetchTool, webSearchTool } from "./webTools.js";
import { config } from "../config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  PROFILES,
  defaultToolsForProfile,
  tokenizeAllowlistedCommand,
  unrestrictedReadTools,
  type ToolName,
  type ProfileName,
  type Permission,
} from "./toolDispatchProfiles.js";
import type { ToolCall, ToolResult, ToolResultHook } from "./toolDispatchTypes.js";
import {
  BASH_TIMEOUT_MS,
  BASH_TIMEOUT_AUTO_MS,
  readTool,
  listTool,
  globTool,
  grepTool,
  bashTool,
  proposeHunksTool,
  writeTool,
  editTool,
  gitStatusTool,
  gitDiffTool,
} from "./nativeToolHandlers.js";

// Re-exports for existing importers.
export {
  tokenizeAllowlistedCommand,
  defaultToolsForProfile,
  PROFILES,
  unrestrictedReadTools,
};
export type { ToolName, ProfileName, Permission };
export type { ToolCall, ToolResult, ToolResultHook };

/**
 * Map invented tool names (Claude/Cursor/etc.) onto native ToolDispatcher tools.
 * Live: 36632e9e wrap-up burned 8 contests on `str_replace_editor`.
 */
export function canonicalizeToolName(name: string): string {
  const n = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const aliases: Record<string, ToolName> = {
    str_replace_editor: "edit",
    str_replace: "edit",
    search_replace: "edit",
    apply_patch: "edit",
    apply_diff: "edit",
    multi_edit: "edit",
    replace_in_file: "edit",
    write_file: "write",
    create_file: "write",
    shell: "run",
    powershell: "run",
    cmd: "run",
    terminal: "run",
    execute: "run",
    bash_tool: "bash",
  };
  // Preserve original casing for unknown names (MCP tools may be case-sensitive).
  return aliases[n] ?? name;
}

export class ToolDispatcher {
  private mcpClients: Map<string, { client: Client; transport: StdioClientTransport; proc?: ChildProcess }> = new Map();
  private mcpToolToClient: Map<string, string> = new Map(); // toolName -> clientKey
  /** Resolves when MCP spawn/connect finishes (or immediately if MCP disabled). */
  private readonly mcpReady: Promise<void>;
  /** Optional run id for contestable denials + one-shot allows. */
  private runId?: string;

  constructor(
    private readonly profile: ProfileName,
    private readonly clonePath: string,
    mcpServers?: string,
    private readonly agentId?: string,
    private readonly onToolResult?: ToolResultHook,
    runId?: string,
  ) {
    this.runId = runId;
    if (
      mcpServers
      && config.SWARM_ALLOW_MCP_SERVERS
      && (profile === "swarm-research"
        || profile === "swarm-read"
        || profile === "swarm-planner"
        || profile === "swarm-builder-research")
    ) {
      this.mcpReady = this.initMcpServers(mcpServers).catch((e) => {
        console.error("MCP init failed", e);
      });
    } else {
      if (mcpServers && !config.SWARM_ALLOW_MCP_SERVERS) {
        console.warn(
          "MCP servers requested but SWARM_ALLOW_MCP_SERVERS=false — ignoring (set true to opt in; RCE surface).",
        );
      }
      this.mcpReady = Promise.resolve();
    }
  }

  /** Await MCP connect before first tool use (avoids race on fire-and-forget init). */
  async whenMcpReady(): Promise<void> {
    await this.mcpReady;
  }

  /** Registered MCP tool names (namespaced `key:tool` plus bare aliases). */
  listMcpToolNames(): string[] {
    return [...this.mcpToolToClient.keys()];
  }

  private async initMcpServers(mcpServers: string) {
    if (!config.SWARM_ALLOW_MCP_SERVERS) {
      return;
    }
    const { parseMcpServerSpecs, mcpSpawnEnvForCmd } = await import("./mcpServerSpecs.js");
    const specs = parseMcpServerSpecs(mcpServers);
    // Only allow a small set of package-manager entrypoints when opt-in.
    const MCP_BIN_ALLOW = new Set(["npx", "npx.cmd", "node", "bun", "bunx", "python", "python3"]);
    for (const { key, command, args, rawCmd } of specs) {
      try {
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
          env: mcpSpawnEnvForCmd(rawCmd),
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
          console.log(
            `[MCP] Search server "${key}" connected. Native profile tools still list web_search (DDG); ` +
              `MCP tools are available as ${toolNames.map((n) => `${key}:${n}`).join(", ") || "(none)"} if the model calls them by name.`,
          );
        }
      } catch (e: any) {
        const msg = e?.message || String(e);
        console.error(`[MCP] Failed to spawn/connect "${key}": ${msg}`);
        if (key.toLowerCase().includes("search") || rawCmd.includes("open-websearch") || rawCmd.includes("heventure")) {
          console.warn(
            `[MCP] Tip: set SWARM_ALLOW_MCP_SERVERS=true and use ` +
              `"search=npx -y open-websearch@latest" (semicolon-separate multiple servers). ` +
              `open-websearch needs MODE=stdio for MCP (we set that automatically). ` +
              `Native DuckDuckGo web_search works without MCP.`,
          );
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

  /** Bind run id after construct (callers that create dispatcher early). */
  setRunId(runId: string | undefined): void {
    this.runId = runId;
  }

  async dispatch(call: ToolCall): Promise<ToolResult> {
    // Ensure MCP servers finished connecting before first tool dispatch.
    await this.mcpReady;
    // Live 36632e9e / 4de10651: models invent Claude/Cursor tool names.
    // Map common aliases onto real tools before profile + switch.
    const tool = canonicalizeToolName(call.tool);
    const callNorm: ToolCall =
      tool === call.tool ? call : { ...call, tool: tool as ToolName };
    let result: ToolResult;
    const profilePerms = PROFILES[this.profile] as Record<ToolName, Permission>;
    const perm = profilePerms[callNorm.tool as ToolName];
    if (perm !== "allow") {
      // One-shot allow after peer/master approved a contest.
      const {
        consumeToolAllowOnce,
        openToolContest,
        formatContestableDenial,
        publishToolContestEvent,
      } = await import("./toolContest.js");
      if (consumeToolAllowOnce(this.runId, this.agentId, callNorm.tool)) {
        // fall through to execute as if allowed
      } else {
      // Check if it's an MCP tool (namespaced or direct)
      const mcpKey = this.mcpToolToClient.get(callNorm.tool) || this.mcpToolToClient.get(`${callNorm.tool}`);
      if (mcpKey && this.mcpClients.has(mcpKey)) {
        result = await this.callMcpTool(mcpKey, callNorm.tool, callNorm.args);
        this.notifyToolResult(callNorm.tool, result);
        return result;
      }
      // Contestable denial (profile leash) — not path sandbox.
      let denyError = `tool "${callNorm.tool}" denied by profile "${this.profile}"`;
      if (tool !== call.tool) {
        denyError += ` (alias of "${call.tool}")`;
      }
      if (this.runId && this.agentId) {
        const contest = openToolContest({
          runId: this.runId,
          agentId: this.agentId,
          tool: callNorm.tool,
          profile: this.profile,
          denyReason: denyError,
        });
        denyError = formatContestableDenial({
          tool: callNorm.tool,
          profile: this.profile,
          contestId: contest.id,
        });
        try {
          publishToolContestEvent({
            contest,
            phase: "opened",
            sink: { runId: this.runId, clonePath: this.clonePath },
          });
        } catch {
          /* best-effort */
        }
      }
      const denied: ToolResult = {
        ok: false,
        error: denyError,
      };
      this.notifyToolResult(callNorm.tool, denied);
      return denied;
      }
    }
    switch (callNorm.tool) {
      case "read":
        result = await readTool(this.clonePath, callNorm.args, unrestrictedReadTools(this.profile));
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
        // Auto-approve (swarm-auto): no consecutive-fail lockout; longer timeout.
        const auto = this.profile === "swarm-auto";
        if (!auto) {
          const prior = getAgentBashErrors(this.agentId);
          if (prior >= BASH_ERROR_BACKOFF_THRESHOLD) {
            result = {
              ok: false,
              error:
                `bash disabled after ${prior} consecutive failures — use read, grep, or glob instead`,
            };
            break;
          }
        }
        result = await bashTool(this.clonePath, call.args, {
          timeoutMs: auto ? BASH_TIMEOUT_AUTO_MS : BASH_TIMEOUT_MS,
        });
        if (!auto) recordAgentBashResult(this.agentId, result.ok);
        break;
      }
      case "propose_hunks":
        result = await proposeHunksTool(this.clonePath, call.args);
        break;
      case "write":
        result = await writeTool(this.clonePath, call.args);
        break;
      case "edit":
        result = await editTool(this.clonePath, call.args);
        break;
      case "git_status":
        result = await gitStatusTool(this.clonePath);
        break;
      case "git_diff":
        result = await gitDiffTool(this.clonePath, call.args);
        break;
      case "run": {
        // Preferred host-shell name (Windows-honest). Same sandbox as bash.
        const autoRun = this.profile === "swarm-auto";
        if (!autoRun) {
          const prior = getAgentBashErrors(this.agentId);
          if (prior >= BASH_ERROR_BACKOFF_THRESHOLD) {
            result = {
              ok: false,
              error:
                `run disabled after ${prior} consecutive shell failures — use read, grep, or glob instead`,
            };
            break;
          }
        }
        result = await bashTool(this.clonePath, call.args, {
          timeoutMs: autoRun ? BASH_TIMEOUT_AUTO_MS : BASH_TIMEOUT_MS,
        });
        if (!autoRun) recordAgentBashResult(this.agentId, result.ok);
        break;
      }
      case "web_fetch": {
        const { preflightResearchTool } = await import("./researchPolicy.js");
        const blocked = preflightResearchTool("web_fetch", call.args);
        result = blocked ?? (await webFetchTool(call.args));
        break;
      }
      case "web_search": {
        const { preflightResearchTool } = await import("./researchPolicy.js");
        const blocked = preflightResearchTool("web_search", call.args);
        result = blocked ?? (await webSearchTool(call.args, {
          cloneRoot: this.clonePath,
          runId: this.runId,
        }));
        break;
      }
      default: {
        const mcpKey2 = this.mcpToolToClient.get(callNorm.tool);
        if (mcpKey2 && this.mcpClients.has(mcpKey2)) {
          result = await this.callMcpTool(mcpKey2, callNorm.tool, callNorm.args);
        } else {
          result = {
            ok: false,
            error:
              tool !== call.tool
                ? `unknown tool ${call.tool} (canonicalized to ${callNorm.tool})`
                : `unknown tool ${callNorm.tool}`,
          };
        }
      }
    }
    this.notifyToolResult(callNorm.tool, result);
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

