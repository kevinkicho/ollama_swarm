# fix-off-by-one (eval fixture)

Tiny fixture for the multi-provider scoreboard. The `countDown` function in `src/countdown.js` has an off-by-one bug — the loop exits before pushing `1`, so `countDown(3)` returns `[3, 2]` instead of `[3, 2, 1]`.

A baseline / preset run should change the loop condition from `i > 1` to `i >= 1` (or `i > 0`).

**Verify:** `npm test` (which runs `node verify.mjs`). Three asserts: `countDown(3) === [3,2,1]`, `countDown(1) === [1]`, `countDown(0) === []`. Exit 0 on pass, 1 on fail.

**No deps.** Vendored-deps-free; runs on plain Node 24+.
