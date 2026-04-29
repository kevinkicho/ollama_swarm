# multistep-config-then-test

Two-step task: extend `formatLog` with a new option AND add a test exercising it.

**Task:**
1. In `src/log.js`, extend `formatLog(level, msg, opts)` so that when `opts.verbose === true`, the returned string includes a `[v]` marker after the level (e.g. `"INFO [v]: hello"`). Default behavior (no opts.verbose, or false) must be unchanged.
2. Create `src/log.test.mjs` that uses `node:test` to assert BOTH the verbose-true case AND the default case. Tests must pass.

**Verify:** `npm test`. Asserts both halves: the function behaves correctly AND the test file exists, references `verbose`, and runs green via `node --test`.

**No deps.**
