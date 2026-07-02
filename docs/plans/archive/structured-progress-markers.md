# Plan: Structured Progress Markers + Better Thinking UI

## Problem

The "thinking..." UI shows raw streaming text or a simple "thinking 45s..." counter.
Users can't tell what the agent is actually doing — reading files? writing hunks? stuck?

## Solution: Two Parts

### Part 1: Progress Markers in System Prompts

Add rules to worker, planner, and auditor system prompts telling agents to emit
structured progress markers as they work. These appear in the streaming text before
the final JSON response.

**Marker format:** `[PROGRESS: type: detail]`

Types:
- `[PROGRESS: read: src/App.jsx]` — reading a file
- `[PROGRESS: grep: "pattern"]` — searching for something
- `[PROGRESS: plan: step 3/7]` — planning progress
- `[PROGRESS: write: config/dashboardPanels.js]` — writing/modifying a file
- `[PROGRESS: verify: criterion c4]` — checking a criterion
- `[PROGRESS: skip: reason]` — skipping a todo
- `[PROGRESS: done: 5 hunks, 3 files]` — summary before final JSON

**Why this works:**
- Agents already stream text before their final JSON
- The markers are in the streaming text, not in the JSON response
- The UI can parse them without changing response schemas
- If the model ignores the markers, nothing breaks — they're advisory

### Part 2: Better UI to Display Progress

Parse progress markers from streaming text and render them as structured UI:

1. **Progress timeline** — show markers as a vertical timeline with icons
2. **File tree view** — show which files are being read/written
3. **Step counter** — show "step 3/7" progress
4. **Elapsed per step** — how long each step took

## Files to Change

### Part 1: Prompt Changes
1. `server/src/swarm/blackboard/prompts/worker.ts` — add progress marker rules
2. `server/src/swarm/blackboard/prompts/planner.ts` — add progress marker rules
3. `server/src/swarm/blackboard/prompts/auditor.ts` — add progress marker rules

### Part 2: UI Changes
4. `web/src/components/transcript/StreamingDock.tsx` — parse markers, render timeline
5. `web/src/components/PlannerThinkingPanel.tsx` — parse markers, show structured progress
6. `web/src/components/transcript/ProgressTimeline.tsx` — new component for marker timeline

## Implementation

### Step 1: Add marker rules to worker prompt

```typescript
// In WORKER_SYSTEM_PROMPT, add before the HARD RULES section:
"PROGRESS MARKERS: As you work, emit progress markers on their own lines before your final JSON response. These help the UI show what you're doing. Format: [PROGRESS: type: detail]",
"Types: read:filepath, grep:query, plan:step N/M, write:filepath, done:summary",
"Example:",
"[PROGRESS: read: src/App.jsx]",
"[PROGRESS: read: config/dashboardPanels.js]",
"[PROGRESS: write: config/dashboardPanels.js]",
"[PROGRESS: done: 3 hunks applied to 2 files]",
"{\"hunks\": [...]}",
"",
```

### Step 2: Create ProgressTimeline component

```tsx
// Parses streaming text for [PROGRESS: ...] markers
// Renders as a vertical timeline with icons per type
function ProgressTimeline({ text }: { text: string }) {
  const markers = parseProgressMarkers(text);
  return (
    <div className="space-y-1">
      {markers.map((m, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <Icon type={m.type} />
          <span className="text-ink-300">{m.detail}</span>
          {m.elapsed && <span className="text-ink-500">{m.elapsed}s</span>}
        </div>
      ))}
    </div>
  );
}
```

### Step 3: Integrate into StreamingDock

Replace raw text display with ProgressTimeline when markers are detected.
Fall back to raw text when no markers found.

### Step 4: Integrate into PlannerThinkingPanel

Show structured progress: "Step 3/7 — Reading src/App.jsx"
Show file tree: files touched so far
Show criteria progress: "4/12 criteria met"

## Expected Impact

| Before | After |
|--------|-------|
| "thinking 45s..." | "Step 3/7 — Reading src/App.jsx (12s)" |
| Raw streaming text | Structured timeline with icons |
| No idea what's happening | Clear progress at a glance |

## Risk

- Models may not consistently emit markers → fallback to raw text (no degradation)
- Markers add ~100 tokens to prompt → negligible cost
- Parser must be tolerant of partial/malformed markers → regex with graceful fallback
