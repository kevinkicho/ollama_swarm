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

---

## Part 2: Replanner — Same Problem, Worse Outcome

### Problem

The replanner has the same windowed-view issue, but with worse consequences. When a
todo goes stale and the replanner can't find the target section in the windowed view:

```
[system] Replanner skipped todo t111: The target 'Demographics' section does not
exist in the current file; the file has been substantially reorganized and the
original move cannot be applied as described.
```

The replanner gives up and skips the todo entirely — even though the work (adding a
UNHCR Refugee row) still needs to be done. The section was likely renamed or moved,
not deleted.

### Root Cause

Two issues compound:

1. **Windowed view**: The replanner sees head (3000 chars) + tail (3000 chars) of
   `docs/PANELS.md`. The "Demographics" section is in the omitted middle, so the
   replanner can't find it.

2. **Replanner prompt encourages skipping**: Rule at line 158 says "Pick SKIP when:
   the original intent no longer applies to the repo as it stands now." The LLM
   interprets "section not in head/tail" as "section doesn't exist" and skips.

### Fix: Apply Auto-Anchor to Replanner Too

The same `extractSectionKeywords` heuristic from Part 1 applies. When the replanner
reads a file and it's windowed, auto-detect anchors from the todo description before
sending the prompt.

#### Changes

1. **`server/src/swarm/blackboard/replanManager.ts`** — After reading fileContents,
   apply the same auto-anchor detection as workerRunner:

   ```typescript
   // After reading fileContents (line 106)
   for (const f of todo.expectedFiles) {
     const content = contents[f];
     if (!content || content.length <= WORKER_FILE_WINDOW_THRESHOLD) continue;
     const keywords = extractSectionKeywords(todo.description);
     for (const kw of keywords) {
       if (content.indexOf(kw) >= 0) {
         // Found the section — inject as anchor so windowFileWithAnchors
         // shows the relevant region
         seed.autoAnchors = [...(seed.autoAnchors ?? []), kw];
       }
     }
   }
   ```

2. **`server/src/swarm/blackboard/prompts/replanner.ts`** — Include auto-anchors
   in the user prompt so the replanner sees the relevant region:

   ```typescript
   // In buildReplannerUserPrompt, after file contents
   if (seed.autoAnchors && seed.autoAnchors.length > 0) {
     parts.push(`[Auto-detected anchors from description: ${seed.autoAnchors.join(", ")}]`);
     // Re-render the file content with anchors injected
     for (const f of seed.originalExpectedFiles) {
       const content = fileContents[f];
       if (!content || content.length <= WORKER_FILE_WINDOW_THRESHOLD) continue;
       const anchored = windowFileWithAnchors(content, seed.autoAnchors);
       // Replace the plain windowed view with anchored view
     }
   }
   ```

3. **Strengthen replanner prompt** — Add explicit instruction:

   ```
   IMPORTANT: When a section is not visible in the shown file contents, it may
   have been RENAMED or MOVED to a different location in the file — NOT deleted.
   Use your tools (grep, read) to search for the section before skipping. Only
   skip when you have CONCRETE EVIDENCE the section was removed, not just when
   you can't see it in the shown excerpt.
   ```

### Additional: Plumb Auto-Anchor to Shared Module

Since both workerRunner and replanManager need `extractSectionKeywords` and the
auto-anchor logic, extract them into a shared module:

**`server/src/swarm/blackboard/autoAnchor.ts`**:
```typescript
export function extractSectionKeywords(description: string): string[] { ... }
export function autoDetectAnchors(
  description: string,
  fileContents: Record<string, string | null>,
  expectedFiles: string[],
): string[] { ... }
```

Both workerRunner and replanManager import from this shared module.
