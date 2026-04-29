# multistep-add-script

Two-step task. The fixture has `src/greeter.js` that exports `greet(name)`. Missing: an entry point + a script that runs it.

**Task:**
1. Create `src/main.js` that imports `greet` from `./greeter.js` and calls `greet("world")`, printing the result.
2. Add a `greet` script to `package.json` that invokes `src/main.js` (`"greet": "node src/main.js"` is the canonical shape).

**Verify:** `npm test`. Asserts: (a) `package.json` declares a `greet` script, (b) `src/main.js` exists + imports `./greeter.js` + calls `greet`, (c) running `src/main.js` prints `hello, world!`.

**No deps.**
