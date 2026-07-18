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

export class ToolDispatcher {
  private mcpClients: Map<string, { client: Client; transport: StdioClientTransport; proc?: ChildProcess }> = new Map();
  private mcpToolToClient: Map<string, string> = new Map(); // toolName -> clientKey
  /** Resolves when MCP spawn/connect finishes (or immediately if MCP disabled). */
  private readonly mcpReady: Promise<void>;

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

  async dispatch(call: ToolCall): Promise<ToolResult> {
    // Ensure MCP servers finished connecting before first tool dispatch.
    await this.mcpReady;
    let result: ToolResult;
    const profilePerms = PROFILES[this.profile] as Record<ToolName, Permission>;
    const perm = profilePerms[call.tool];
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
      case "web_fetch": {
        const { preflightResearchTool } = await import("./researchPolicy.js");
        const blocked = preflightResearchTool("web_fetch", call.args);
        result = blocked ?? (await webFetchTool(call.args));
        break;
      }
      case "web_search": {
        const { preflightResearchTool } = await import("./researchPolicy.js");
        const blocked = preflightResearchTool("web_search", call.args);
        result = blocked ?? (await webSearchTool(call.args, { cloneRoot: this.clonePath }));
        break;
      }
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

