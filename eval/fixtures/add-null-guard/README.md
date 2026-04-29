# add-null-guard

`formatUser(input)` in `src/format.js` dereferences `input.name` without checking `input` itself. Calling `formatUser(null)` throws.

**Fix:** add a null guard at the top of the function that returns `"Anonymous <unknown>"` when `input` is `null` or `undefined`.

**Verify:** `npm test` (runs `node verify.mjs`). Asserts the happy path still works AND that `formatUser(null)` / `formatUser(undefined)` both return the fallback without throwing.

**No deps.**
