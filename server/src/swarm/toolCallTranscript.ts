import type { TranscriptEntrySummary } from "../types.js";

export function webToolCallSummary(
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

export function makeWebToolHandler(
  append: WebToolAppender,
  agentId: string,
): (info: { tool: string; ok: boolean; preview: string }) => void {
  return ({ tool, ok, preview }) => {
    append(
      formatWebToolSystemLine(agentId, tool, ok, preview),
      webToolCallSummary(tool, ok, preview),
    );
  };
}