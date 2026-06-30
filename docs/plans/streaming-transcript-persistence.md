# Implementation Plans

## Plan 1: Streaming Transcript Persistence

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
    // Find where to insert (before the agent entry we're about to add)
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

### TranscriptTimeline Integration

The `TranscriptTimeline` component (History tab) already reads from the transcript.
Since `agent-stream` entries are now part of the transcript, they'll automatically
appear in the history timeline — collapsed by default.

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

1. **`web/src/types.ts`** — Add `"agent-stream"` to transcript role union, add `StreamingMeta` interface
2. **`web/src/state/store.ts`** — In `appendEntry`, convert streaming to transcript entry before deleting
3. **`web/src/components/transcript/StreamingTranscriptCard.tsx`** — New component (collapsible card)
4. **`web/src/components/Transcript.tsx`** — Render `agent-stream` entries with new component
5. **`web/src/state/applyEvent.test.ts`** — Add tests for streaming-to-transcript conversion

## Edge Cases

- **Empty streaming text** (<50 chars): Don't create a stream entry — the agent didn't produce meaningful thinking
- **Multiple agents streaming simultaneously**: Each gets its own `agent-stream` entry
- **Agent retries (repair prompt)**: Each attempt gets its own stream entry
- **Brain fallback**: Brain output is part of the agent's streaming text, so it's preserved automatically
- **Streaming cleared by sweeper** (30s timeout): The sweeper fires when the agent died without producing a response — no stream entry to preserve (correct behavior)
- **Run ends mid-streaming**: The streaming entries that were cleared by `terminal phase` reset won't have a matching transcript_append — these are lost (acceptable — the run crashed)

## Testing

1. Unit test: `appendEntry` with agent-stream conversion preserves text and meta
2. Unit test: streaming text <50 chars is NOT converted to transcript entry
3. Component test: `StreamingTranscriptCard` renders collapsed/expanded states
4. Integration test: full flow — streaming → append → transcript shows both entries

---

## Plan 2: Worker Context Files — Let Workers See Related Files

### Problem

Workers decline todos because they can only see the files in `expectedFiles`. When a todo
needs context from other files (like `config/dashboardPanels.js` to understand what
endpoints exist), the worker can't see them and must decline:

```
[agent-4] worker declined todo: Cannot update docs/PANELS.md without the content
of config/dashboardPanels.js to know the exact endpoints, sources, and descriptions
for the missing tabs.
```

### Root Cause

In `workerRunner.ts:391`:
```typescript
contents = await ctx.readExpectedFiles(todo.expectedFiles);
```

The worker ONLY gets the 1-2 declared files. No mechanism to provide additional context.

### Solution: Add `contextFiles` to Todo

Add an optional `contextFiles` field that declares files the worker needs to READ
(but not modify). The planner generates these, the worker runner reads them, and the
prompt includes them as read-only context.

### Changes

#### 1. `shared/src/types.ts` or `server/src/swarm/blackboard/types.ts`

Add to Todo interface:
```typescript
interface Todo {
  // existing fields...
  contextFiles?: string[];  // files the worker needs to READ (not modify)
}
```

#### 2. `server/src/swarm/blackboard/TodoQueue.ts`

Pass `contextFiles` through when posting todos. The `postTodoQ` wrapper should accept
an optional `contextFiles` parameter.

#### 3. `server/src/swarm/blackboard/prompts/planner.ts`

Update `PLANNER_SYSTEM_PROMPT` to tell the planner it can declare `contextFiles`:

```
15. CONTEXT FILES — for TODOs that reference or depend on files NOT in
    expectedFiles, include an optional `contextFiles` array listing those
    files. The worker will see their content as read-only reference.
    Do NOT put files in contextFiles that you intend to modify — those
    go in expectedFiles. Max 3 context files per TODO.
```

Add `contextFiles` to the planner TODO schema:
```json
"contextFiles": z.array(filePathEntry).max(3).optional()
```

#### 4. `server/src/swarm/blackboard/workerRunner.ts`

Read both `expectedFiles` AND `contextFiles`:
```typescript
const allFiles = [
  ...todo.expectedFiles,
  ...(todo.contextFiles ?? []),
];
contents = await ctx.readExpectedFiles(allFiles);
```

Pass all contents to the seed:
```typescript
const seed: WorkerSeed = {
  // existing fields...
  contextFiles: todo.contextFiles ?? [],
};
```

#### 5. `server/src/swarm/blackboard/prompts/worker.ts`

Add `contextFiles` to `WorkerSeed`:
```typescript
interface WorkerSeed {
  // existing fields...
  contextFiles: string[];
}
```

Update `buildWorkerUserPrompt` to render context files as read-only:
```typescript
if (seed.contextFiles.length > 0) {
  parts.push("=== READ-ONLY CONTEXT FILES (do NOT modify these) ===");
  for (const f of seed.contextFiles) {
    const content = seed.fileContents[f];
    if (content === null || content === undefined) {
      parts.push(`=== ${f} (does not exist — available for reference only) ===`);
    } else {
      const view = windowFileForWorker(content);
      const header = view.full
        ? `=== ${f} (${content.length} chars, full) ===`
        : `=== ${f} (${content.length} chars, WINDOWED) ===`;
      parts.push(header);
      parts.push(view.content);
      parts.push(`=== end ${f} ===`);
    }
    parts.push("");
  }
}
```

#### 6. `server/src/swarm/blackboard/prompts/worker.ts` — parseWorkerResponse

Keep the existing security check: hunks can only target `expectedFiles`:
```typescript
const allowed = new Set(expectedFiles);  // contextFiles NOT included
// ... hunk validation unchanged
```

#### 7. `server/src/swarm/blackboard/prompts/jsonSchemas.ts`

Add `contextFiles` to the planner TODO schema:
```typescript
const PlannerTodoSchema = z.object({
  description: z.string().trim().min(1).max(500),
  expectedFiles: z.array(filePathEntry).min(1).max(2),
  contextFiles: z.array(filePathEntry).max(3).optional(),
  // ... existing fields
});
```

### Test Files to Update

- `server/src/swarm/blackboard/prompts/planner.test.ts` — planner can emit contextFiles
- `server/src/swarm/blackboard/prompts/worker.test.ts` — worker prompt includes context files
- `server/src/swarm/blackboard/TodoQueue.test.ts` — contextFiles preserved through queue
- `server/src/swarm/blackboard/workerRunner.test.ts` — contextFiles read and passed to seed

### Example Flow

1. Planner creates todo:
   ```json
   {
     "description": "Update docs/PANELS.md to add the new government data panel entries",
     "expectedFiles": ["docs/PANELS.md"],
     "contextFiles": ["config/dashboardPanels.js", "src/App.jsx"]
   }
   ```

2. Worker runner reads 3 files: `docs/PANELS.md`, `config/dashboardPanels.js`, `src/App.jsx`

3. Worker prompt includes:
   ```
   TODO: Update docs/PANELS.md to add the new government data panel entries
   Expected files: docs/PANELS.md
   === Current contents of docs/PANELS.md ===
   ...
   === READ-ONLY CONTEXT FILES (do NOT modify these) ===
   === config/dashboardPanels.js ===
   ...
   === src/App.jsx ===
   ...
   ```

4. Worker produces hunks targeting ONLY `docs/PANELS.md` (context files are read-only)
