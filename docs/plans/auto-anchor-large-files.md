# Plan 3: Auto-Anchor for Large Files — Fix "Cannot Edit Middle Region" Declines

## Problem

Workers decline todos because the target file is too large (>8KB) and windowed
(head + tail only), so the section they need to edit is in the omitted middle:

```
[agent-3] worker declined todo: The Demographics tab section is not visible
in the windowed head or tail of docs/PANELS.md, so I cannot create a unique
search anchor to insert the UNHCR Refugee row.
```

The "context files" plan (Plan 2) won't help here — the worker CAN see the file
(it's in `expectedFiles`), but the file is too large to show in full.

## Root Cause

`docs/PANELS.md` is ~15KB. `windowFileForWorker` shows only head (3000 chars) +
tail (3000 chars). The "Demographics" section is in the omitted middle. The worker
can't create a search anchor for a section it can't see.

The planner SHOULD have declared `expectedAnchors` (Rule 10 in planner prompt) —
this would trigger `windowFileWithAnchors` which injects ±25 lines around each
anchor. But the planner didn't, so the worker got the plain windowed view.

## Solution: Auto-Detect Anchors from Todo Description

When the worker runner reads a file and it's windowed, **auto-detect likely anchors**
from the todo description and inject them before building the prompt.

### Changes

#### 1. `server/src/swarm/blackboard/workerRunner.ts`

After reading `expectedFiles`, for each large file, check if the todo description
mentions a section/region. If the file is windowed and no `expectedAnchors` were
declared, grep the file for keywords from the description:

```typescript
// After reading fileContents
const autoAnchors: string[] = [];
for (const f of todo.expectedFiles) {
  const content = contents[f];
  if (!content || content.length <= WORKER_FILE_WINDOW_THRESHOLD) continue;
  if (todo.expectedAnchors && todo.expectedAnchors.length > 0) continue;
  
  // Extract likely section names from the todo description
  // e.g., "Add UNHCR Refugee row to Demographics section" → ["Demographics"]
  const keywords = extractSectionKeywords(todo.description);
  for (const kw of keywords) {
    const idx = content.indexOf(kw);
    if (idx >= 0) {
      autoAnchors.push(kw);
    }
  }
}
if (autoAnchors.length > 0 && todo.expectedAnchors === undefined) {
  todo.expectedAnchors = autoAnchors;
}
```

#### 2. `server/src/swarm/blackboard/workerRunner.ts` — keyword extraction

Simple heuristic: look for capitalized words that appear in the file as section headers:

```typescript
function extractSectionKeywords(description: string): string[] {
  // Extract quoted strings first (e.g., "Demographics" → "Demographics")
  const quoted = [...description.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  // Extract capitalized words >3 chars (likely section names)
  const capitalized = description
    .split(/\s+/)
    .filter(w => w.length > 3 && /^[A-Z]/.test(w) && !/TODO|CREATE|UPDATE|ADD|DELETE|MOVE|FIX|FILE|THE|AND|FOR|WITH/.test(w));
  return [...new Set([...quoted, ...capitalized])];
}
```

### Why Not Just Show More of the File?

The windowed view exists for a reason — a 49KB file in the prompt blows past the
model's context budget. `windowFileWithAnchors` already handles this: it shows
head + ±25 lines per anchor + tail. The issue is that anchors aren't being declared.

### Alternative: Planner Prompt Improvement

Instead of auto-detecting in the worker runner, we could strengthen the planner
prompt to ALWAYS declare anchors for large files. But the planner is already
instructed to do this (Rule 10) — the issue is that it sometimes doesn't comply.
Auto-detection is a safety net.

## Files to Change

1. `server/src/swarm/blackboard/workerRunner.ts` — Auto-detect anchors from description
2. `server/src/swarm/blackboard/workerRunner.test.ts` — Test auto-anchor detection

## Edge Cases

- File is large but description has no recognizable keywords → no anchors added
- File is large and planner already declared anchors → auto-detection skipped
- Auto-detected anchor doesn't match the actual section → worker sees "miss" in anchored report
- Todo description is generic ("fix the file") → no useful keywords extracted
