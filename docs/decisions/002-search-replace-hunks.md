# ADR 002 — Search/replace hunks instead of full-file replacement or unified diffs

**Status:** accepted
**Decided:** Unit 31 era (2026-04 sometime; pre-V2)
**Last verified:** 2026-04-27

## Decision

Workers return file edits as Aider-style search/replace hunks:

```ts
{ op: "replace", file: "...", search: "<exact text>", replace: "<new text>" }
{ op: "create",  file: "...", content: "<full content>" }
{ op: "append",  file: "...", content: "<text to append>" }
```

The runner applies hunks in order via `applyHunks` (pure, side-effect
free, unit-testable) then writes results.

## Context

V1 of the worker output was `{ file, newText }` — a full-file
replacement. That made prompts explode on large files: a worker
editing a 49KB README sent the whole 49KB back, on top of receiving
it in the prompt. Combined with Ollama cloud latency, that blew past
undici's 5-min headers timeout on every README-touching todo (see
phase11c-medium-v5 run, criterion c2 unmet).

## Alternatives considered

1. **Full-file replacement (V1).** Trivially validatable but blew
   prompt budget on large files; failure mode was "worker times out"
   not "diff malformed."

2. **Unified diff (`git diff` format).** More compact than full-file
   but parsing is non-trivial (line numbers can drift, hunk headers
   matter, `+++`/`---` need to match). Models routinely produce
   subtly malformed unified diffs; the JSON envelope was rejected
   by zod and we'd lose attempts.

3. **Search/replace hunks (this ADR).** Models produce these
   reliably (no line-number arithmetic). The search anchor must be
   unique in the file or `applyHunks` fails closed with a clear
   reason — the worker can retry with a more specific anchor. Three
   ops cover everything we need: `replace`, `create`, `append`.

## Trade-offs

- **Cost:** large refactors that touch many lines may need the worker
  to emit several hunks instead of one large edit. The token cost
  per "ambiguous anchor" failure is the worker's full reply (which
  might be 5-10KB).
- **Win:** model can target a small anchor instead of producing a
  whole-file blob. Conflict detection is automatic — if a sibling
  worker changed the search anchor between read and apply, the apply
  fails closed (this is what V2's `WorkerPipelineV2` relies on
  instead of CAS+lock-files).
- **Limit:** can't easily express "delete entire file" or "rename
  file." Neither has come up in practice.

## When to revisit

- If we add a worker preset that needs to do bulk-rename or large
  deletions, those would need new ops (`delete`, `rename`).
- If a model that's better at unified-diff semantics ships and we
  want to opt into it for that model only.

## References

- `server/src/swarm/blackboard/applyHunks.ts` — the apply logic
- `server/src/swarm/blackboard/applyHunks.test.ts` — exhaustive cases
- `server/src/swarm/blackboard/prompts/worker.ts` — prompt + zod schema
- `docs/blackboard-response-schemas.md` — envelope JSON shape
