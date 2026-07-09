import type { TranscriptEntrySummary } from "../types.js";

export type ToolTraceEntry = {
  tool: string;
  ok: boolean;
  preview: string;
  ts: number;
};

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

// Back-compat alias
export const webToolCallSummary = toolInvokeSummary;