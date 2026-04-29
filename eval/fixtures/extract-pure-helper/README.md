# extract-pure-helper

`computePrice(items)` in `src/calc.js` inlines the tax calculation. Extract it into a pure helper called `applyTax(amount)` so it's reusable + testable.

**Constraints:** behavior must be preserved exactly. The exported `computePrice` signature must not change. Tests must still pass.

**Verify:** `npm test`. Asserts: (1) `computePrice` returns the same numbers as before; (2) `src/calc.js` declares a function/const/let named `applyTax`.

**No deps.**
