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

## Current fixtures (10 total — all verified-fail-on-broken-state)

### Code-modify (6)

| Task id | What it tests | Verify |
|---|---|---|
| [`fix-off-by-one`](./fix-off-by-one/) | Change a loop terminator | 3 `countDown` asserts |
| [`add-null-guard`](./add-null-guard/) | Add a null guard at the top of a function | Happy path + null/undefined fallback asserts |
| [`extract-pure-helper`](./extract-pure-helper/) | Refactor without behavior change | Behavior preserved + helper-name grep |
| [`fix-failing-test`](./fix-failing-test/) | Fix a wrong assertion (not the function) | `node --test` runs green |
| [`rename-symbol`](./rename-symbol/) | Rename a function across multiple files | Old-name grep absence + behavior assert |
| [`add-readme-section`](./add-readme-section/) | Add a `## Usage` heading with content | Heading regex + content length gate |

### Analysis (2)

| Task id | What it tests | Verify |
|---|---|---|
| [`audit-console-logs`](./audit-console-logs/) | Produce a JSON report listing every console.log call | report.json shape: `{count: 5, calls: [{file, line}, ...]}` |
| [`categorize-deps`](./categorize-deps/) | Read package.json, classify deps as runtime/dev/optional | categories.json shape with set-equal name lists |

### Multi-step (2)

| Task id | What it tests | Verify |
|---|---|---|
| [`multistep-add-script`](./multistep-add-script/) | Create entry + add npm script that runs it | package.json script + main.js content + actual stdout `"hello, world!"` |
| [`multistep-config-then-test`](./multistep-config-then-test/) | Extend a function with a new option AND write a test exercising it | Both behaviors + new test file references `verbose` AND passes |

All ten verify scripts: exit 0 on success, exit 1 with a single `FAIL: <reason>` line on failure. All deps-free; pin Node 24+ via your `engines` field if the fixture needs it.
