// During-run Brain FAB chat: rich run snapshot + read-only exploration tools.
import fs from "node:fs";
import path from "node:path";
import { BRAIN_ALIAS_USER_NOTE } from "@ollama-swarm/shared/brainAlias";
import { formatServerSummary } from "@ollama-swarm/shared/formatServerSummary";
import type { TranscriptEntrySummary } from "@ollama-swarm/shared/transcriptEntrySummary";
import { config } from "../config.js";
import { resolveSystemLayerModel } from "../services/systemLayerSettings.js";
import type { Orchestrator } from "../services/Orchestrator.js";
import type { SwarmStatus } from "../types/run.js";
import {
  ToolDispatcher,
  type ToolCall,
  type ToolResult,
} from "../tools/ToolDispatcher.js";

export interface BrainRunContextClient {
  runId?: string;
  preset?: string;
  userDirective?: string;
  phase?: string;
  clonePath?: string;
  recentTranscript?: Array<{
    role: string;
    text: string;
    summaryKind?: string;
    summary?: TranscriptEntrySummary;
  }>;
  boardCounts?: Record<string, number>;
  recentTodos?: Array<{ id: string; description: string; status: string }>;
  agentCount?: number;
  activeAgents?: number;
  wallClockMs?: number;
}

export interface EnrichedBrainRunContext {
  runId: string;
  clonePath?: string;
  markdown: string;
  toolsEnabled: boolean;
  modelString: string;
}

/** Read-only exploration tools for Brain during live runs. */
export const BRAIN_EXPLORE_TOOLS = [
  "read",
  "grep",
  "glob",
  "list",
  "web_fetch",
  "web_search",
] as const;

const SWARM_INFRA_PREFIXES = [
  "server/",
  "web/",
  "shared/",
  "scripts/",
  "node_modules/",
  ".git/",
];

const SWARM_INFRA_EXACT = new Set([
  ".env",
  ".env.example",
  "package.json",
  "package-lock.json",
]);

export function isSwarmAppClone(clonePath: string): boolean {
  try {
    const root = path.resolve(clonePath);
    return (
      fs.existsSync(path.join(root, "server", "src", "index.ts"))
      && fs.existsSync(path.join(root, "web", "package.json"))
    );
  } catch {
    return false;
  }
}

export function isProtectedInfraPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (SWARM_INFRA_EXACT.has(norm)) return true;
  return SWARM_INFRA_PREFIXES.some((p) => norm === p.slice(0, -1) || norm.startsWith(p));
}

/** Guard reads of ollama_swarm infrastructure when the run clone is this repo. */
export class BrainExplorerDispatcher {
  private readonly inner: ToolDispatcher;
  private readonly guardInfra: boolean;

  constructor(clonePath: string) {
    this.inner = new ToolDispatcher("swarm-research", clonePath);
    this.guardInfra = isSwarmAppClone(clonePath);
  }

  async dispatch(call: ToolCall): Promise<ToolResult> {
    if (call.tool === "write" || call.tool === "edit" || call.tool === "bash" || call.tool === "propose_hunks") {
      return {
        ok: false,
        error:
          "Brain chat is read-only. Describe changes for swarm agents or use the Amend action — do not edit files directly.",
      };
    }
    if (this.guardInfra) {
      const rel = String(call.args.path ?? call.args.pattern ?? "");
      if (rel && isProtectedInfraPath(rel)) {
        return {
          ok: false,
          error:
            `Protected app infrastructure (${rel}). Explore the run workspace / user project areas instead of server/web/shared tooling.`,
        };
      }
    }
    return this.inner.dispatch(call);
  }
}

function brainToolsEnabledForModel(modelString: string): boolean {
  return /^(anthropic|openai|opencode)/.test(modelString);
}

/** Resolve Brain / system-layer model: client override → env → paid keys → cloud default. */
export function pickBrainChatModelWithTools(
  clientModel?: string,
): { modelString: string; toolsEnabled: boolean } {
  const fromClient = clientModel?.trim();
  if (fromClient) {
    return { modelString: fromClient, toolsEnabled: brainToolsEnabledForModel(fromClient) };
  }
  const override = config.SWARM_BRAIN_MODEL?.trim();
  if (override) {
    return { modelString: override, toolsEnabled: brainToolsEnabledForModel(override) };
  }
  if (config.ANTHROPIC_API_KEY) {
    return { modelString: "anthropic/claude-haiku-4-5", toolsEnabled: true };
  }
  if (config.OPENAI_API_KEY) {
    return { modelString: "openai/gpt-4o-mini", toolsEnabled: true };
  }
  if (config.OPENCODE_GO_API_KEY || config.OPENCODE_ZEN_API_KEY || config.OPENCODE_API_KEY) {
    return { modelString: "opencode-go/deepseek-v4-flash", toolsEnabled: true };
  }
  return { modelString: "deepseek-v4-flash:cloud", toolsEnabled: false };
}

function resolveRunId(orch: Orchestrator, runId?: string): string | undefined {
  if (!runId) return undefined;
  const status = orch.statusForRun(runId);
  return status?.runId ?? runId;
}

function formatTranscriptLine(entry: {
  role: string;
  text?: string;
  summary?: TranscriptEntrySummary;
  ts?: number;
  agentIndex?: number;
}): string {
  const who =
    entry.role === "agent" && entry.agentIndex != null
      ? `agent-${entry.agentIndex}`
      : entry.role;
  const body = entry.summary
    ? formatServerSummary(entry.summary)
    : (entry.text ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
  return `- **${who}**: ${body || "(empty)"}`;
}

function formatAgentLines(status: SwarmStatus): string[] {
  const roles = status.runConfig?.roles;
  return (status.agents ?? []).map((a) => {
    const roleName = roles?.[a.index - 1];
    const bits = [
      `agent-${a.index}`,
      a.status,
      a.model ? a.model : null,
      roleName ? `role=${roleName}` : null,
    ].filter(Boolean);
    return `- ${bits.join(" · ")}`;
  });
}

function formatBoardSection(status: SwarmStatus): string {
  const board = status.board;
  if (!board) return "_No blackboard state (non-blackboard preset or not started)._";
  const c = board.counts;
  const lines = [
    `| open | claimed | committed | stale |`,
    `| ${c.open} | ${c.claimed} | ${c.committed} | ${c.stale} |`,
  ];
  const todos = (board.todos ?? []).slice(0, 12);
  if (todos.length > 0) {
    lines.push("", "**Todos (sample):**");
    for (const t of todos) {
      lines.push(`- \`${t.id}\` [${t.status}] ${t.description?.slice(0, 120) ?? ""}`);
    }
  }
  return lines.join("\n");
}

export function buildRunSnapshotMarkdown(
  status: SwarmStatus,
  clientCtx?: BrainRunContextClient,
): string {
  const cfg = status.runConfig;
  const elapsed =
    status.runStartedAt != null
      ? `${Math.round((Date.now() - status.runStartedAt) / 1000)}s`
      : clientCtx?.wallClockMs != null
        ? `${Math.round(clientCtx.wallClockMs / 1000)}s`
        : "?";
  const transcript = status.transcript ?? [];
  const recent = transcript.slice(-24);

  const sections = [
    "## Active run",
    "",
    `- **Run ID**: \`${status.runId ?? clientCtx?.runId ?? "?"}\``,
    `- **Preset**: ${cfg?.preset ?? clientCtx?.preset ?? status.summary?.preset ?? "?"}`,
    `- **Phase**: ${status.phase ?? clientCtx?.phase ?? "?"}`,
    `- **Round**: ${status.round ?? 0}`,
    `- **Elapsed**: ${elapsed}`,
    `- **Workspace**: \`${cfg?.clonePath ?? status.localPath ?? clientCtx?.clonePath ?? "?"}\``,
    "",
    "### Directive",
    cfg?.userDirective
      || clientCtx?.userDirective
      || "_none_",
    "",
    "### Models",
    `- planner: \`${cfg?.plannerModel ?? "?"}\``,
    `- worker: \`${cfg?.workerModel ?? "?"}\``,
    `- auditor: \`${cfg?.auditorModel ?? "?"}\``,
    "",
    "### Agents",
    ...formatAgentLines(status),
    "",
    "### Board",
    formatBoardSection(status),
  ];

  if (status.contract?.criteria?.length) {
    const met = status.contract.criteria.filter((c) => c.status === "met").length;
    sections.push(
      "",
      "### Contract",
      `${met}/${status.contract.criteria.length} criteria met`,
    );
  }

  const tg = status.thinkGuardReferee;
  if (tg) {
    sections.push(
      "",
      "### Think-guard referee",
      `- **Enabled**: ${tg.enabled}`,
      `- **Calls**: ${tg.callsUsed}/${tg.maxCallsPerRun} (${tg.callsRemaining} remaining)`,
      `- **Min think chars for referee**: ${tg.minThinkCharsForReferee.toLocaleString()}`,
      `- **Think tail sent to referee**: ${tg.thinkTailMinChars.toLocaleString()}–${tg.thinkTailMaxChars.toLocaleString()} chars`,
      `- **Referee max output tokens**: ${tg.maxOutputTokens}`,
      "",
      "When agents burn long think-only streams (reasoning loops), suggest RECONFIG to enable referee or raise max calls / tail / output tokens.",
    );
  }

  const streaming = status.streaming ?? {};
  const streamKeys = Object.keys(streaming);
  if (streamKeys.length > 0) {
    sections.push("", "### Live streams");
    for (const id of streamKeys.slice(0, 4)) {
      const s = streaming[id];
      const preview = (s?.text ?? "").replace(/\s+/g, " ").slice(0, 100);
      sections.push(`- **${id}**: ${preview}${preview.length >= 100 ? "…" : ""}`);
    }
  }

  sections.push("", "### Recent transcript (newest last)");
  if (recent.length === 0) {
    sections.push("_No transcript entries yet._");
  } else {
    for (const e of recent) {
      sections.push(
        formatTranscriptLine({
          role: e.role,
          text: e.text,
          summary: e.summary as TranscriptEntrySummary | undefined,
          agentIndex: (e as { agentIndex?: number }).agentIndex,
        }),
      );
    }
  }

  return sections.join("\n");
}

export function enrichBrainRunContext(
  orch: Orchestrator,
  clientCtx: BrainRunContextClient,
  clientModel?: string,
): EnrichedBrainRunContext | null {
  const runId = resolveRunId(orch, clientCtx.runId);
  if (!runId) return null;

  const status = orch.statusForRun(runId);
  const { modelString, toolsEnabled } = resolveSystemLayerModel(clientModel);
  const clonePath =
    clientCtx.clonePath
    ?? status?.runConfig?.clonePath
    ?? status?.localPath
    ?? status?.cloneState?.clonePath;

  const markdown = status
    ? buildRunSnapshotMarkdown(status, clientCtx)
    : [
        "## Active run (limited snapshot)",
        "",
        `- **Run ID**: \`${runId}\``,
        `- **Phase**: ${clientCtx.phase ?? "?"}`,
        `- **Preset**: ${clientCtx.preset ?? "?"}`,
        "",
        "_Full server status unavailable — using client-provided context only._",
        "",
        "```json",
        JSON.stringify(clientCtx, null, 2),
        "```",
      ].join("\n");

  return { runId, clonePath, markdown, toolsEnabled, modelString };
}

export function buildDuringRunSystemPrompt(snapshotMarkdown: string, toolsEnabled: boolean): string {
  const toolSection = toolsEnabled
    ? `
## Exploration tools (read-only)
You have tools: read, grep, glob, list, web_fetch, web_search.
- Use them to inspect the **run workspace** and research external facts.
- **Never** write, edit, or execute shell commands — you cannot modify files.
- When the workspace is the ollama_swarm app itself, do **not** read or suggest edits under server/, web/, shared/, scripts/, node_modules/, or .env — those are protected infrastructure.
- Prefer summarizing findings in clear markdown for the user.`
    : `
## Exploration (no live tools on this provider)
You do not have file tools in this session. Rely on the run snapshot below and ask the user to paste specifics if you need more detail.`;

  return `You are **Brain**, the run assistant for ollama_swarm. The user is watching a **live swarm run** and opened chat from the run view.
${BRAIN_ALIAS_USER_NOTE}

Your job:
1. Answer questions about **this specific run** using the snapshot below (and tools when available).
2. Interpret progress, agent behavior, board/todos, and transcript events.
3. Suggest **amendments** or next steps in plain language (user applies via Amend / agents).
4. When the user needs **more time or rounds**, suggest a **RECONFIG** block (extend-only limits) they can apply with one click.
5. When think streams are long or looping, manage **think-guard referee** budget via RECONFIG (absolute fields: \`thinkGuardRefereeEnabled\`, \`thinkGuardRefereeMaxCallsPerRun\`, \`thinkGuardRefereeMinThinkChars\`, \`thinkGuardRefereeThinkTailMinChars\`, \`thinkGuardRefereeThinkTailMaxChars\`, \`thinkGuardRefereeMaxOutputTokens\`).
6. Format every reply in clean **Markdown**: short headings, bullet lists, \`code\` for paths/ids, tables when comparing state.

Do **not**:
- Pretend you lack run context — the snapshot is authoritative for what has happened so far.
- Recommend starting a new swarm unless the user explicitly asks.
- Suggest editing protected app infrastructure files.

${toolSection}

---

# Current run snapshot

${snapshotMarkdown}`;
}