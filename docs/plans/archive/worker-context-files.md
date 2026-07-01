# Plan 2: Worker Context Files — Let Workers See Related Files

## Problem

Workers decline todos because they can only see the files in `expectedFiles`. When a todo
needs context from other files (like `config/dashboardPanels.js` to understand what
endpoints exist), the worker can't see them and must decline:

```
[agent-4] worker declined todo: Cannot update docs/PANELS.md without the content
of config/dashboardPanels.js to know the exact endpoints, sources, and descriptions
for the missing tabs.
```

## Root Cause

In `workerRunner.ts:391`:
```typescript
contents = await ctx.readExpectedFiles(todo.expectedFiles);
```

The worker ONLY gets the 1-2 declared files. No mechanism to provide additional context.

## Solution: Add `contextFiles` to Todo

Add an optional `contextFiles` field that declares files the worker needs to READ
(but not modify). The planner generates these, the worker runner reads them, and the
prompt includes them as read-only context.

## Changes

### 1. `server/src/swarm/blackboard/types.ts`

Add to Todo interface:
```typescript
interface Todo {
  contextFiles?: string[];  // files the worker needs to READ (not modify)
}
```

### 2. `server/src/swarm/blackboard/TodoQueue.ts`

Pass `contextFiles` through when posting todos.

### 3. `server/src/swarm/blackboard/prompts/planner.ts`

Add rule to planner prompt:
```
15. CONTEXT FILES — for TODOs that reference or depend on files NOT in
    expectedFiles, include an optional `contextFiles` array listing those
    files. The worker will see their content as read-only reference.
    Do NOT put files in contextFiles that you intend to modify — those
    go in expectedFiles. Max 3 context files per TODO.
```

Add `contextFiles` to planner TODO schema:
```typescript
contextFiles: z.array(filePathEntry).max(3).optional()
```

### 4. `server/src/swarm/blackboard/workerRunner.ts`

Read both `expectedFiles` AND `contextFiles`:
```typescript
const allFiles = [
  ...todo.expectedFiles,
  ...(todo.contextFiles ?? []),
];
contents = await ctx.readExpectedFiles(allFiles);
```

### 5. `server/src/swarm/blackboard/prompts/worker.ts`

Add `contextFiles` to `WorkerSeed` and render them as read-only:
```typescript
if (seed.contextFiles.length > 0) {
  parts.push("=== READ-ONLY CONTEXT FILES (do NOT modify these) ===");
  for (const f of seed.contextFiles) {
    const content = seed.fileContents[f];
    if (content === null) {
      parts.push(`=== ${f} (does not exist) ===`);
    } else {
      const view = windowFileForWorker(content);
      parts.push(`=== ${f} (${content.length} chars) ===`);
      parts.push(view.content);
      parts.push(`=== end ${f} ===`);
    }
  }
}
```

### 6. Security: hunks can only target `expectedFiles` (unchanged)

```typescript
const allowed = new Set(expectedFiles);  // contextFiles NOT included
```

## Example Flow

1. Planner creates todo:
   ```json
   {
     "description": "Update docs/PANELS.md to add the new government data panel entries",
     "expectedFiles": ["docs/PANELS.md"],
     "contextFiles": ["config/dashboardPanels.js", "src/App.jsx"]
   }
   ```

2. Worker runner reads 3 files, worker prompt includes all as context
3. Worker produces hunks targeting ONLY `docs/PANELS.md`
