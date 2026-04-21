# Blackboard Agent Response Schemas

Every LLM turn in the blackboard preset is expected to return a JSON payload
matching a **strict, zod-validated schema**. This doc is the single source of
truth for what each agent role must emit, why the shapes look the way they do,
and how we handle the inevitable "LLM produced something almost right" case.

**Scope.** These schemas are specific to the **blackboard preset** — they
exist because the blackboard's data model (`Todo`, `Diff`, replan action)
needs a machine-parseable contract between LLM and runner. Other presets in
`docs/swarm-patterns.md` use different contracts:

- **Round-robin** (current pre-preset mode in `RoundRobinRunner.ts`): no JSON,
  agents speak free-form prose, the transcript is the only output.
- **Future presets** (role-differentiation, map-reduce, etc. — see
  `swarm-patterns.md`) will define their own contracts as needed. Nothing
  about `diffs` / `revised` / `skip` is portable — each preset owns its own
  shapes.

**Stack independence.** The schemas are defined by *our* prompts and parsers,
not by any layer beneath us:

| Layer           | Contribution to the response shape                  |
| --------------- | --------------------------------------------------- |
| `glm-5.1:cloud` | None — it's just a language model.                  |
| Ollama          | None — just an inference runtime.                   |
| OpenCode        | None — just a session/transport API.                |
| **Our prompts** | **Define the schema** via system prompt + examples. |
| **Our parsers** | **Enforce the schema** via zod at parse time.       |

Swapping the model (GPT-4, Claude, Qwen) or the backend (Ollama → vLLM) would
not change a single line in these schemas. Only the prompts might need minor
re-tuning so the new model reliably produces the same JSON.

---

## The three roles

Prompt files and parsers live together in
`server/src/swarm/blackboard/prompts/`:

| Role         | Prompt file      | Parser                   | Zod schema                       |
| ------------ | ---------------- | ------------------------ | -------------------------------- |
| Planner      | `planner.ts`     | `parsePlannerResponse`   | `PlannerResponseSchema`          |
| Worker       | `worker.ts`      | `parseWorkerResponse`    | `WorkerResponseSchema`           |
| Replanner    | `replanner.ts`   | `parseReplannerResponse` | `ReplannerResponseSchema` (union)|

### 1. Planner

Runs once at the start of `executing`, producing the initial todo list.

**Shape:** top-level JSON array (not wrapped in an object).

```json
[
  {
    "description": "Short imperative task description (≤500 chars).",
    "expectedFiles": ["path/relative/to/clone/root.ts"]
  },
  {
    "description": "Another todo.",
    "expectedFiles": ["src/foo.ts", "src/foo.test.ts"]
  }
]
```

**Constraints (`PlannerResponseSchema`):**
- Top-level must be an array. Max 20 todos.
- `description`: trimmed string, 1–500 chars.
- `expectedFiles`: 1–2 entries. Each a non-empty trimmed string. No validation
  of path structure here — the worker's CAS check later enforces that the
  path resolves safely inside the clone.

### 2. Worker

Runs once per claimed todo. Produces either the new file contents, or a
decline reason.

**Shape:** top-level JSON object with `diffs` always present and an optional
`skip` reason.

```json
{
  "diffs": [
    {
      "file": "src/foo.ts",
      "newText": "// full new contents of src/foo.ts (max 200 KB)"
    }
  ]
}
```

To voluntarily decline (e.g. "the thing the todo asks for is already done"):

```json
{
  "diffs": [],
  "skip": "already present on line 12"
}
```

**Constraints (`WorkerResponseSchema`):**
- `diffs`: array, max 2 entries. Can be empty when `skip` is present.
- Each diff: `file` 1–1000 char trimmed string, `newText` up to 200,000 chars.
- `skip`: optional trimmed string, 1–500 chars.
- **Additional runtime checks in the runner** (beyond zod):
  - Every `diff.file` must appear in the todo's `expectedFiles`.
  - No duplicate `file` entries within a single response.
  - `newText` is written via tmp+rename with an atomic CAS hash check.

### 3. Replanner

The **planner agent wearing a different hat** (see
`docs/known-limitations.md` §"Planner does double duty as the replanner").
Runs whenever a todo goes stale.

**Shape:** discriminated union — exactly one of `revised` or `skip`.

Revise path — shrink scope / retarget files:

```json
{
  "revised": {
    "description": "Create unit tests for pure functions in src/brain.ts.",
    "expectedFiles": ["src/__tests__/brain.test.ts"]
  }
}
```

Skip path — give up on the todo entirely:

```json
{
  "skip": true,
  "reason": ".orchestrator-workspaces/ is already present in .gitignore on line 12"
}
```

**Constraints (`ReplannerResponseSchema` = `RevisedSchema | SkipSchema`):**
- `revised.description`: 1–500 chars trimmed.
- `revised.expectedFiles`: 1–2 entries, each non-empty trimmed.
- `skip`: must be literal `true` (not `false`, not a string).
- `skip.reason`: 1–500 chars trimmed.
- **Mixed-intent shapes are rejected.** `{revised: ..., skip: true}` fails.
- **Top-level arrays are rejected.** Shape must be a single object.

---

## Parse pipeline

All three parsers share the same extraction strategy (implemented
independently in each file so they can evolve separately, but the flow is
identical):

1. **Strict `JSON.parse(raw)` first.** A perfectly-shaped response must not
   be damaged by the later heuristics.
2. **Fence-strip fallback.** If step 1 fails, look for a \`\`\`json ... \`\`\`
   or bare \`\`\` ... \`\`\` fence and parse its contents. Outer fence first,
   then an inner fence inside prose.
3. **Prose-slice fallback.** If no fence exists, slice between the first `{`
   (or `[` for planner) and the last matching delimiter. Only meaningful when
   there's prose before the opening brace.
4. **Zod validation.** Whatever JSON came out of the extraction goes through
   the schema. Failures produce `{ok: false, reason: "..."}` with a
   human-readable reason (missing field, wrong type, size violation, etc.).

On parse failure, the runner issues **one repair prompt** using a role-
specific repair template (e.g. `buildReplannerRepairPrompt(response, reason)`)
that includes the original bad response and the validator's reason. If the
repair also fails, the runner gives up:

- **Worker:** runner calls `board.markStale(todoId, "worker response invalid: <reason>")`, which then enters the replan queue.
- **Planner:** runner posts 0 todos; run terminates with a system message
  indicating the planner was unusable.
- **Replanner:** runner calls `board.skip(todoId, "replanner response invalid: <reason>")`, closing the todo.

Everything after the repair step assumes the parse succeeded — there is no
third try.

---

## Why these shapes (design notes)

**Full-file `newText`, not unified diffs.** Patch formats are fragile: the
LLM has to count lines, get context right, and match whitespace exactly. A
full-file rewrite sidesteps every one of those failure modes at the cost of
extra tokens. The 200 KB cap + `expectedFiles` cap of 2 bounds the worst
case. Upgrading to a patch format is a v2 concern explicitly called out in
`worker.ts`.

**Planner returns bare array, others return an object.** The planner could
have been `{todos: [...]}` for symmetry, but a bare array is what the model
reliably produces with the fewest mistakes. Worker and replanner need
multiple sibling fields (`diffs` + optional `skip`, or the `revised`/`skip`
union), so they must be objects.

**Discriminated union for replanner.** The replanner has two genuinely
different intents (revise vs. give up) that take different downstream paths
in the runner (`Board.replan` vs. `Board.skip`). A union forces the LLM to
pick one — avoiding ambiguous "I revised it but also kind of want to skip"
responses that a flat `{action: "revise" | "skip", ...}` shape would invite.

**`skip` on workers is a separate escape hatch** from the replanner. Worker
skip means "I looked at the file, the todo is already satisfied, no changes
needed" — a fast exit that avoids burning a planner turn. The runner treats
a worker `skip` by marking the todo stale with the skip reason, which then
routes to the replanner for the final decision (revise vs. formally skip).

---

## Debugging checklist

When a response fails to parse (surfaces as `worker response invalid:` /
`replanner response invalid:` in the transcript):

1. Read `logs/current.jsonl` for the most recent `transcript_append` with
   `role: "agent"` — that's the raw LLM output.
2. Paste into the relevant parser's test file and add a failing case —
   `prompts/worker.test.ts`, `planner.test.ts`, `replanner.test.ts`. Run it
   and watch the zod error message.
3. Common failure modes:
   - Response wrapped in extra prose ("Sure! Here's the JSON: ...").
     Fence-strip and prose-slice handle most of these, but a *second* prose
     block after the JSON can still trip it.
   - Fields renamed or hallucinated (`patches` instead of `diffs`,
     `files` instead of `expectedFiles`).
   - `expectedFiles` contains 3+ entries — the model ignored the cap.
   - For replanner: emitted both `revised` and `skip` simultaneously.
4. If it's a prompt bug (not a parser bug), the fix is in the prompt's
   system message or worked examples — not the zod schema. Loosening the
   schema to accept bad output is almost never the right move.

For historical context on every schema change, see
`docs/blackboard-changelog.md` (phases 3, 4, and 6 touch these files).
