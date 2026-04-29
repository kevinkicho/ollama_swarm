# fix-failing-test

`src/sum.test.mjs` has a broken assertion: `sum(2, 3)` is asserted to equal `6` (it's `5`). The production function `src/sum.js` is correct.

**Fix:** change the assertion (or the test description) so the test passes WITHOUT modifying `src/sum.js`. Tests should match the function's actual behavior.

**Verify:** `npm test`. Runs `node --test src/sum.test.mjs`; exits 0 if all 3 tests pass.

**No deps.**
