# Plan 1: Streaming Transcript Persistence

## Problem

When an agent finishes thinking, the streaming text (intermediate reasoning, tool calls,
partial JSON) is deleted from the store. The user sees the "thinking" bubble disappear
and a clean `MessageBubble` appear — but the intermediate reasoning text is lost.
There is no record of what the agent was "thinking" before it produced its final output.

## Current Flow

```
agent_streaming event
  → store.setStreaming(agentId, cumulativeText)    // bubble shows live text
  → StreamingDock renders PersistentStreamBubble

agent_streaming_end event
  → store.markStreamingEnded(agentId)              // bubble status → "done"
  → StreamingDock shows ✓ + "done · 1,269 chars"

transcript_append event (agent response)
  → store.deleteStreaming(agentId)                 // BUBBLE DELETED
  → Transcript renders MessageBubble                // clean final response
```

The streaming text is ephemeral — useful during the turn but gone after.

## Solution: Convert Streaming to Transcript Entry on Finalize

When `transcript_append` arrives for an agent that has streaming text, **convert the
streaming entry into a persistent transcript entry** instead of deleting it.

### New Transcript Role

Add `role: "agent-stream"` — a new transcript entry type that represents the
agent's intermediate thinking/reasoning text.

```typescript
interface TranscriptEntry {
  id: string;
  role: "system" | "agent" | "agent-stream";  // ← new role
  text: string;
  ts: number;
  agentId?: string;
  // NEW fields for agent-stream entries:
  streamingMeta?: {
    startedAt: number;
    lastTextAt: number;
    toolCallCount: number;
    totalSeconds: number;
  };
}
```

### Store Change (`store.ts`)

In the `appendEntry` action, before deleting from streaming:

```typescript
// Before deleting streaming, check if there's substantial text to preserve
if (e.agentId && e.agentId in nextStreaming) {
  const streamingText = nextStreaming[e.agentId];
  const meta = nextMeta[e.agentId];
  
  // Preserve if >50 chars or if it had tool calls — trivial responses
  // don't need a separate stream entry
  if (streamingText && streamingText.length > 50) {
    const streamEntry: TranscriptEntry = {
      id: `stream-${e.agentId}-${Date.now()}`,
      role: "agent-stream",
      text: streamingText,
      ts: meta?.startedAt ?? Date.now(),
      agentId: e.agentId,
      streamingMeta: {
        startedAt: meta?.startedAt ?? Date.now(),
        lastTextAt: meta?.lastTextAt ?? Date.now(),
        toolCallCount: 0,  // could be extracted from stripToolCallLeak
        totalSeconds: meta ? Math.round((meta.lastTextAt - meta.startedAt) / 1000) : 0,
      },
    };
    // Insert the stream entry BEFORE the agent's final response
    // so the thinking appears chronologically before the result
    const insertIdx = s.transcript.length;
    s.transcript.splice(insertIdx, 0, streamEntry);
  }
  delete nextStreaming[e.agentId];
  delete nextMeta[e.agentId];
}
```

### New Component: `StreamingTranscriptCard`

A collapsible card that renders `agent-stream` entries:

```tsx
function StreamingTranscriptCard({ entry }: { entry: TranscriptEntry }) {
  const [expanded, setExpanded] = useState(false);
  const meta = entry.streamingMeta;
  const hue = hueForAgent(/* extract agent index from agentId */);
  const palette = agentBubblePalette(hue, false);

  return (
    <div className="rounded border p-2 text-sm" style={{ borderColor: palette.border, background: palette.background }}>
      <button onClick={() => setExpanded(!expanded)} className="w-full text-left flex items-center gap-2">
        <span className="text-ink-500">{expanded ? "▾" : "▸"}</span>
        <span style={{ color: palette.header }} className="font-semibold">
          Agent {entry.agentId}
        </span>
        <span className="text-ink-500 text-xs">
          thinking {meta?.totalSeconds ?? "?"}s · {entry.text.length.toLocaleString()} chars
        </span>
        {meta?.toolCallCount ? (
          <span className="text-amber-400/70 text-[10px]">
            🔧 {meta.toolCallCount} tool call{meta.toolCallCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="mt-2 whitespace-pre-wrap text-xs opacity-80 overflow-y-auto max-h-[300px]">
          {entry.text}
        </div>
      ) : null}
    </div>
  );
}
```

### Transcript.tsx Change

In the transcript render loop, detect `agent-stream` role and render differently:

```tsx
{filteredTranscript.map((entry, i) => {
  if (entry.role === "agent-stream") {
    return <StreamingTranscriptCard key={entry.id} entry={entry} />;
  }
  // existing MessageBubble rendering
  return <MessageBubble key={entry.id} entry={entry} ... />;
})}
```

### Visual Design

```
┌─────────────────────────────────────────────────┐
│ ▸ Agent 2 · thinking 14s · 1,269 chars · 🔧 3  │  ← collapsed (default)
├─────────────────────────────────────────────────┤
│ { "hunks": [                                     │  ← expanded on click
│     { "op": "replace",                           │
│       "file": "src/App.jsx",                     │
│       ...                                        │
│ }                                                │
├─────────────────────────────────────────────────┤
│ Agent 2 · 1,269 chars · 4.2s                    │  ← final MessageBubble
│                                                 │
│ {"hunks": [{"op": "replace", ...}]}             │
└─────────────────────────────────────────────────┘
```

## Files to Change

1. `web/src/types.ts` — Add `"agent-stream"` to transcript role union, add `StreamingMeta` interface
2. `web/src/state/store.ts` — In `appendEntry`, convert streaming to transcript entry before deleting
3. `web/src/components/transcript/StreamingTranscriptCard.tsx` — New component (collapsible card)
4. `web/src/components/Transcript.tsx` — Render `agent-stream` entries with new component
5. `web/src/state/applyEvent.test.ts` — Add tests for streaming-to-transcript conversion

## Edge Cases

- Empty streaming text (<50 chars): Don't create a stream entry
- Multiple agents streaming simultaneously: Each gets its own `agent-stream` entry
- Agent retries (repair prompt): Each attempt gets its own stream entry
- Brain fallback: Brain output is part of the agent's streaming text, preserved automatically
- Streaming cleared by sweeper (30s timeout): No stream entry to preserve (correct)
- Run ends mid-streaming: Lost (acceptable — run crashed)
