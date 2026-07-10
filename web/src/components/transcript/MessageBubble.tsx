// V2 Step 4: extracted from Transcript.tsx so the scroll container
// (Transcript.tsx) is just the scroll/sticky-bottom logic and per-entry
// rendering is its own concern.
//
// Dispatch only: system → SystemBubble, user → CollapsibleBlock,
// agent → AgentBubble.

import { memo } from "react";
import type { TranscriptEntry } from "../../types";
import { CollapsibleBlock } from "./JsonBubbles";
import { ToolCallsBlock } from "./ToolCallsBlock";
import { SystemBubble } from "./SystemBubble";
import { AgentBubble } from "./AgentBubble";

export const MessageBubble = memo(function MessageBubble({ entry }: { entry: TranscriptEntry }) {
  const ts = new Date(entry.ts).toLocaleTimeString();
  // Wrap every entry in a stable div so Playwright + other DOM
  // inspectors can address each transcript entry without relying on
  // class names that change with restyles. data-summary-kind is
  // omitted when no summary is attached (server didn't tag the entry)
  // so absence is itself a signal.
  return (
    <div
      data-entry-id={entry.id}
      data-entry-role={entry.role}
      className="transcript-bubble box-border"
      style={{ margin: 0, padding: 0 }} /* ensure no extra margins leak into measured height */
      {...(entry.summary?.kind ? { "data-summary-kind": entry.summary.kind } : {})}
      {...(typeof entry.agentIndex === "number" ? { "data-agent-index": entry.agentIndex } : {})}
      {...(entry.thoughts ? { "data-has-thoughts": "true" } : {})}
      {...(entry.toolCalls && entry.toolCalls.length > 0 ? { "data-has-tool-calls": String(entry.toolCalls.length) } : {})}
    >
      {/* Task #229 (2026-04-27 evening): render XML pseudo-tool-call
          markers as a collapsed amber block. Separate from thoughts
          because they're a different kind of leaked-intent signal —
          these are tool invocations the model emitted as text instead
          of via the SDK function. */}
      {entry.toolCalls && entry.toolCalls.length > 0 ? (
        <ToolCallsBlock markers={entry.toolCalls} />
      ) : null}
      {entry.role === "system" ? (
        <SystemBubble entry={entry} ts={ts} />
      ) : entry.role === "user" ? (
        <CollapsibleBlock
          className="rounded-md border border-ink-600 bg-ink-800 p-3 text-sm"
          header={
            <div className="text-xs text-ink-400 mb-1 flex items-center gap-2">
              <span>you · {ts}</span>
              {entry.intent ? (
                <span
                  className={`inline-block px-1.5 py-0 text-[9px] uppercase tracking-wider rounded ${
                    entry.intent === "suggest"
                      ? "bg-sky-900/50 text-sky-300"
                      : entry.intent === "ask"
                        ? "bg-violet-900/50 text-violet-300"
                        : "bg-amber-900/50 text-amber-300"
                  }`}
                >
                  {entry.intent}
                </span>
              ) : null}
            </div>
          }
          text={entry.text}
        />
      ) : (
        <AgentBubble entry={entry} ts={ts} />
      )}
    </div>
  );
});
