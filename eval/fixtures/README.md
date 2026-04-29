# eval/fixtures — verifiable scoreboard tasks

Self-contained mini-repos used by the multi-provider scoreboard. Each fixture is a directory the eval harness clones (cp -r) for every preset×attempt, runs the swarm against, then evaluates by executing the fixture's `verify.mjs` (or `npm test`). Exit 0 = task succeeded; non-zero = failed.

## Pattern (so adding a new fixture is mechanical)

```
eval/fixtures/<task-id>/
├── README.md          ← what the bug is, what the desired fix looks like
├── package.json       ← { "type": "module", "scripts": { "test": "node verify.mjs" } }
├── verify.mjs         ← exits 0 on success, 1 with a FAIL line on failure
└── <code files>       ← the SUT — kept tiny so a 2-min Sonnet run is enough
```

**Hard rules for new fixtures:**

- **No deps.** Every fixture must run on plain `node verify.mjs` with zero `npm install`. Vendor anything you need; the scoreboard sweep should never hit the network during verify.
- **Tiny.** Keep total fixture size under ~200 lines. The point is "can the model fix this in one shot," not "can it understand a real codebase."
- **Deterministic verify.** No timing-sensitive assertions, no reliance on filesystem ordering, no flaky network calls.
- **One concept per fixture.** A fixture that tests three skills at once dilutes the signal — split into three.
- **Vendored Node version assumption.** Tested against Node 24.x; pin in `engines` if a fixture needs something different.

## Current fixtures

| Task id | What it tests | Verify |
|---|---|---|
| [`fix-off-by-one`](./fix-off-by-one/) | Code-modify: change a loop terminator | `node verify.mjs` (3 asserts) |
| [`add-readme-section`](./add-readme-section/) | Docs: add a `## Usage` heading with content | `grep` + content gate |
| [`rename-symbol`](./rename-symbol/) | Code-modify: rename a function across multiple files | grep absence + behavior assert |

## Adding more (queued from the original Phase 6 plan)

The plan called for 10 fixtures across code-modify / analysis / multi-step. The three above are the proven-pattern starting set; the remaining seven from the plan are deliberate follow-ups so the framework lands first:

- `add-null-guard` — function dereferences possibly-null arg; verified by an added test
- `extract-pure-helper` — refactor without behavior change; `npm test` verifies behavior preserved
- `fix-failing-test` — pre-broken test in the fixture; `npm test` verifies it's now green
- `audit-console-logs` — analysis task; verifier checks JSON output shape
- `categorize-deps` — analysis task; verifier checks JSON output shape
- `multistep-add-script-then-call-it` — add npm script + invoke from another file; both grep checks
- `multistep-config-then-test` — add config option + write test exercising it; `npm test` verifies

Add by following the pattern above and updating `eval/catalog.json` (when local-fixture support lands in Phase 7's run-eval.mjs revisions).
