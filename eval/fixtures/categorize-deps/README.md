# categorize-deps

Analysis-style fixture. `package.json` declares deps in three sections: `dependencies`, `devDependencies`, `optionalDependencies`.

**Task:** read `package.json`, write `categories.json` with this shape:

```json
{
  "runtime": ["express", "zod"],
  "dev": ["vitest", "@types/node"],
  "optional": ["fsevents"]
}
```

Lists contain dependency **names only** (not version strings), order doesn't matter.

**Verify:** `npm test`. Asserts each category set matches the expected names exactly.

**No deps installed.** This fixture only reads its own `package.json` — no `npm install` needed.
