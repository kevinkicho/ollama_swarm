# audit-console-logs

Analysis-style fixture. `src/main.js` contains several `console.log` calls.

**Task:** scan `src/` for every `console.log` call. Write a JSON report at `report.json` with the shape:

```json
{
  "count": 5,
  "calls": [
    { "file": "src/main.js", "line": 7 },
    ...
  ]
}
```

**Verify:** `npm test`. Asserts the report exists, has `count: 5`, has 5 entries in `calls`, every entry has `file` ending in `main.js` plus a numeric `line`.

**No deps.**
