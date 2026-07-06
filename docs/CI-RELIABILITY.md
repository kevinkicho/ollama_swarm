# CI Reliability Guide

**Goal:** Make every `git push` (and PR) reliably pass CI on the first try.

This document captures the hard lessons from repeated CI failures and the tooling/process we put in place to prevent them.

## The One Command You Should Run Before Every Push

```bash
npm run verify-ci
```

This script (see `scripts/verify-ci.mjs`) runs **exactly** the same gates that `.github/workflows/ci.yml` runs on GitHub Actions:

1. `npm run typecheck` (shared + server + web)
2. `npm test` (shared + server)
3. `npx tsx server/scripts/discover-runner-fields.ts --check`
4. `npx tsx eval/drift-check.ts`
5. `npm run build`
6. **Untracked source file guard** (catches the #1 cause of "Cannot find module")

If any step fails, the script exits non-zero.

You can also run it via the git hook (see below).

---

## Common Causes of "It Worked Locally but CI Failed"

| Symptom                              | Typical Root Cause                                                                 | How We Prevent It Now                     |
|--------------------------------------|------------------------------------------------------------------------------------|-------------------------------------------|
| `Cannot find module './BrainStartChat'` or similar | New `.ts`/`.tsx` file was never `git add`ed. CI does a clean checkout.            | `verify-ci` untracked guard + hook       |
| `Parameter 'cfg' implicitly has an 'any' type` | New callbacks (Brain chat, pipeline config, etc.) added without type annotations. | Full `typecheck` in verify-ci             |
| `xxx preset block must exist`        | Code moved (e.g. presets extracted from `SetupForm.tsx` to `setup/presets.ts`). Old tests still grepped the wrong file with brittle regex. | Hardened tests + `verify-ci`              |
| Tests pass locally but fail in CI    | Tests rely on `tmpRoot` without guards, or use relative paths that differ on fresh clone. | Improved test hygiene + full test run     |
| Drift / discover checks fail         | You changed prompts, context builders, or runner fields without updating the detectors. | Explicit `--check` steps in verify-ci     |
| Build fails only on CI               | Missing files in the build graph, or web/server build steps not run locally.     | `npm run build` is the last step          |

**Golden rule:** Local success on a dirty working tree + partial commands is not the same as a clean CI checkout.

---

## Git Hook Scaffold (Automatic Enforcement)

We provide a simple, cross-platform git hook that runs `verify-ci` on every push.

### Installation

The hook is installed automatically on `npm install` thanks to the `"prepare"` script.

You can also install it manually at any time:

```bash
npm run setup-git-hooks
# or
node scripts/install-git-hooks.mjs
```

This creates (or updates):

- `.git/hooks/pre-push`
- `.git/hooks/pre-push.cmd` (on Windows)

### How it works

- The hook calls `node scripts/git-hooks/pre-push.mjs`
- That script runs `npm run verify-ci`
- If verification fails → push is aborted with a clear message.
- Emergency bypass: `git push --no-verify` (use rarely and only when you understand the risk).

### Hook files

- `scripts/git-hooks/pre-push.mjs` — the actual logic
- `scripts/install-git-hooks.mjs` — the installer (idempotent, safe to re-run)

If you add more hooks later (pre-commit, commit-msg, etc.), put them in `scripts/git-hooks/` and extend the installer.

---

## Best Practices for Reliable CI

### 1. Always use the verify script (or the hook)

Never push after only running `npm run typecheck` or only tests. The full sequence matters.

### 2. Stage source files immediately

After creating or moving any `.ts` / `.tsx` file:

```bash
git status
git add path/to/new-file.ts
```

The untracked guard in `verify-ci` will catch this.

### 3. When refactoring, run typecheck frequently

Especially dangerous operations:
- Moving code between `web/`, `server/`, and `shared/`
- Extracting components (SetupForm → hooks + subcomponents)
- Renaming preset files or moving data definitions
- Adding dynamic config (Brain, pipeline preset, etc.)

Run `npm run typecheck` after each logical chunk of the refactor.

### 4. Update "introspection" tests when moving data

Several server tests used to do this (and will again if we're not careful):

```ts
// Bad (brittle)
const src = readFileSync("../../../web/src/components/SetupForm.tsx", "utf8");
const block = src.match(/id:\s*"round-robin"[\s\S]{0,800}?\},/);
```

We replaced these with a robust `extractPresetBlock()` helper that uses brace counting. Prefer **actual imports** over source grepping whenever possible:

```ts
// Much better (when feasible)
import { PRESETS } from "../../../web/src/components/setup/presets.js";
const preset = PRESETS.find(p => p.id === "round-robin");
assert.equal(preset?.directive, "honored");
```

If you must read source, use the brace-balanced extractor and keep the path up to date.

### 5. Respect the drift and discovery checks

- `discover-runner-fields.ts --check` — fails if the number of BlackboardRunner fields drifts.
- `drift-check.ts` — validates prompt contracts against current model behavior.

Treat failures here as first-class CI errors. Update the detectors or the prompts accordingly.

### 6. Test cleanup hygiene

Any test that creates temporary directories/files must guard cleanup:

```ts
after(async () => {
  if (tmpRoot) {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});
```

We had several failures because `tmpRoot` was sometimes undefined.

### 7. Use the right environment for tests

Server tests need:

```bash
OPENCODE_SERVER_PASSWORD=test-only npm test
```

The `verify-ci` script and the test runner set this automatically.

---

## Recommended Pre-Push Workflow

```bash
# 1. Make your changes
git add -A   # or be explicit

# 2. Verify everything
npm run verify-ci

# 3. (Optional but recommended) Run the full thing again after any last-minute edits
npm run verify-ci

# 4. Commit + push (the hook will run verify-ci again)
git commit -m "..."
git push
```

If the hook is installed, step 2 is somewhat redundant but still useful for fast feedback.

---

## Adding New CI Gates

When you add a new requirement that must pass on every push:

1. Add the command to `.github/workflows/ci.yml`
2. Add the same step to `scripts/verify-ci.mjs`
3. Document it here
4. Consider whether it should also be part of the git hook (most should)

---

## Emergency Bypass

Only use `--no-verify` when:

- You are fixing the CI infrastructure itself
- You have manually verified on a clean machine/checkout
- You are in an extreme time crunch and accept the risk of a red run

Always follow up with a clean `git push` (or force a new CI run) once the issue is resolved.

---

## Related Files

- `scripts/verify-ci.mjs` — the local CI mirror
- `scripts/git-hooks/pre-push.mjs`
- `scripts/install-git-hooks.mjs`
- `.github/workflows/ci.yml`
- `package.json` (the `verify-ci`, `setup-git-hooks`, and `prepare` scripts)

## Future Improvements (Ideas)

- Add a fast `pre-commit` hook for lint + typecheck on changed files only.
- Move more "form contract" assertions into `shared/` so they can be imported instead of grepped.
- Add a CI step that explicitly lists untracked source files.
- Consider adopting `husky` for more ergonomic hook management if the manual scaffold becomes painful.

---

**Remember:** The goal is not to make CI green. The goal is to make *local development* as close as possible to what CI will see, so green becomes the boring default.

Last significant update: 2026-07 (after repeated module + implicit-any + brittle test failures).
