import type { TranscriptEntrySummary } from "../types.js";

export type ToolTraceEntry = {
  tool: string;
  ok: boolean;
  preview: string;
  ts: number;
};

const TOOL_PREVIEW_MAX = 200;

function summarizeToolArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "read":
    case "list":
      return String(args.path ?? ".").trim();
    case "glob":
      return String(args.pattern ?? "").trim();
    case "grep": {
      const pattern = String(args.pattern ?? "").trim();
      const scope = String(args.path ?? "").trim();
      return scope && scope !== "." ? `${pattern} in ${scope}` : pattern;
    }
    case "bash":
      return String(args.command ?? "").trim().slice(0, 80);
    case "web_fetch":
      return String(args.url ?? "").trim();
    case "web_search":
      return String(args.query ?? "").trim().slice(0, 100);
    default:
      if (tool.includes(":")) return tool;
      return "";
  }
}

/** Human-readable one-liner for tool trace UI (includes args when output is empty). */
export function formatToolInvokePreview(
  tool: string,
  args: Record<string, unknown>,
  result: { ok: true; output: string } | { ok: false; error: string },
): string {
  const argHint = summarizeToolArgs(tool, args);
  if (result.ok) {
    const out = result.output.replace(/\s+/g, " ").trim();
    if (out.length > 0) {
      const clipped = out.length > TOOL_PREVIEW_MAX ? `${out.slice(0, TOOL_PREVIEW_MAX)}…` : out;
      return argHint ? `${argHint} → ${clipped}` : clipped;
    }
    return argHint ? `${argHint} → (no output)` : "(no output)";
  }
  const err = (result.error || "unknown error").replace(/\s+/g, " ").trim();
  const clipped = err.length > TOOL_PREVIEW_MAX ? `${err.slice(0, TOOL_PREVIEW_MAX)}…` : err;
  return argHint ? `${argHint} → ${clipped}` : clipped;
}

export function toolInvokeSummary(
  tool: string,
  ok: boolean,
  preview: string,
): Extract<TranscriptEntrySummary, { kind: "web_tool" }> {
  return {
    kind: "web_tool",
    tool,
    ok,
    preview: preview.slice(0, 200),
  };
}

/** @deprecated Per-tool system lines flood the transcript — use makeBufferedToolHandler. */
export function formatWebToolSystemLine(
  agentId: string,
  tool: string,
  ok: boolean,
  preview: string,
): string {
  const status = ok ? "ok" : "error";
  const short = preview.length > 150 ? `${preview.slice(0, 150)}…` : preview;
  return `[${agentId}] ${tool} ${status}: ${short}`;
}

export type WebToolAppender = (text: string, summary: TranscriptEntrySummary) => void;

/** @deprecated Prefer makeBufferedToolHandler — attaches trace to the next agent bubble. */
export function makeWebToolHandler(
  append: WebToolAppender,
  agentId: string,
): (info: { tool: string; ok: boolean; preview: string }) => void {
  return ({ tool, ok, preview }) => {
    append(
      formatWebToolSystemLine(agentId, tool, ok, preview),
      toolInvokeSummary(tool, ok, preview),
    );
  };
}

/** Buffer tool invocations for attachment to the next appendAgent entry (no per-call transcript spam). */
export function makeBufferedToolHandler(
  pending: Map<string, ToolTraceEntry[]>,
  agentId: string,
): (info: { tool: string; ok: boolean; preview: string }) => void {
  return ({ tool, ok, preview }) => {
    const row: ToolTraceEntry = {
      tool,
      ok,
      preview: preview.slice(0, 200),
      ts: Date.now(),
    };
    const list = pending.get(agentId);
    if (list) list.push(row);
    else pending.set(agentId, [row]);
  };
}

export function takePendingToolTrace(
  pending: Map<string, ToolTraceEntry[]> | undefined,
  agentId: string,
): ToolTraceEntry[] | undefined {
  if (!pending) return undefined;
  const trace = pending.get(agentId);
  if (!trace?.length) return undefined;
  pending.delete(agentId);
  return trace;
}

/** Non-destructive peek for literature citation checks. */
export function peekPendingToolTrace(
  pending: Map<string, ToolTraceEntry[]> | undefined,
  agentId: string,
): readonly ToolTraceEntry[] {
  if (!pending) return [];
  return pending.get(agentId) ?? [];
}

/**
 * Pull https URLs from tool-trace previews (web_fetch args / web_search results).
 * Used by isUsableResearchBrief(text, urls) so briefs must cite real tool output.
 */
export function extractUrlsFromToolTrace(
  entries: readonly ToolTraceEntry[],
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s)\]>"'→]+/gi;
  for (const e of entries) {
    if (!e.ok) continue;
    if (e.tool !== "web_fetch" && e.tool !== "web_search" && !e.tool.includes("search")) {
      // Still scan previews for search MCP tools that embed URLs.
      if (!/search|fetch|http/i.test(e.tool)) continue;
    }
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(e.preview)) !== null) {
      const u = m[0]!.replace(/[.,;:]+$/, "");
      if (seen.has(u)) continue;
      if (/example\.com|your-org|localhost|127\.0\.0\.1|file:\/\//i.test(u)) continue;
      seen.add(u);
      urls.push(u);
    }
  }
  return urls;
}

// Back-compat alias
export const webToolCallSummary = toolInvokeSummary;