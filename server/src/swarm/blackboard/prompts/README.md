# Blackboard & swarm prompt surface

## Fence policy (do not “unify” naively)

| Surface | Markdown fences in **model final answer**? |
|--------|-----------------------------------------------|
| Blackboard structured roles (planner, worker, auditor, contract, replanner, critic, verifier) | **No** — bare JSON only. Fences break fail-closed parsers. |
| Discussion judges / OW lead plan / best-of-N / many JSON helpers | **No** — same contract. |
| **Brain** (idle config chat) | **Yes, intentional** — ` ```json ` config blocks for UX paste/start. |
| Freeform discussion agents | Prose OK; optional ` ```mention ` envelopes only (see `agentMentionContract.ts`). |

Never inject `MENTION_CONTRACT_NOTE` into JSON-only system prompts.

## Shared fragments

- `sharedSnippets.ts` — `JSON_ONLY_FINAL_RULES`, `buildRepoToolsNote`, `MENTION_CONTRACT_NOTE`
- `../../directivePromptHelpers.ts` — discussion + blackboard directive blocks (`buildDirectiveBlock`, `buildBlackboardDirectiveBlock`)

## Drift registry

`registry.ts` lists prompt files + string assertions. `driftGuard.ts` resolves:

- `prompts/*` → this directory (under `blackboard/`)
- other paths → `server/src/swarm/*` (discussion helpers)

Update `version` / `lastValidatedAt` when you change a registered prompt’s contract.

## Prompt surface index (primary)

### Blackboard system prompts (`prompts/`)

| Export | File | Consumer |
|--------|------|----------|
| `PLANNER_SYSTEM_PROMPT` | planner.ts | Blackboard planner |
| `WORKER_SYSTEM_PROMPT` | worker.ts | Council/blackboard workers |
| `AUDITOR_SYSTEM_PROMPT` | auditor.ts | Auditor + council auditor |
| `FIRST_PASS_CONTRACT_SYSTEM_PROMPT` | firstPassContract.ts | Contract phase |
| `REPLANNER_SYSTEM_PROMPT` | replanner.ts | Stale-todo replan |
| `CRITIC_*_SYSTEM_PROMPT` | critic.ts | Pre-commit substance/regression/consistency |
| `VERIFIER_SYSTEM_PROMPT` | verifier.ts | Per-commit todo fidelity |

### Discussion builders (`server/src/swarm/*PromptHelpers.ts`)

| Module | Roles |
|--------|--------|
| councilPromptHelpers | council, synthesis, standup |
| debatePromptHelpers | debater, judge, implementer, reviewer, signoff |
| roundRobinPromptHelpers | turn + synthesis |
| moaPromptHelpers | proposer variants, aggregator |
| mapReducePromptHelpers | mapper, reducer |
| orchestratorWorkerPromptHelpers | lead plan, worker, synthesis |
| orchestratorWorkerDeepPromptHelpers | multi-level plan/synthesis |
| stigmergyPromptHelpers | explorer, territory |

### Other

| Module | Role |
|--------|------|
| bestOfNTurn | K-sample judge |
| dynamicRolePicker / dynamicRoleCatalog | Next-role pick |
| brainDuringRun / brainRoutes | Brain assistant |
| councilReconcile | Vote / judge pick |
| councilDecisions | Todo extract + auditor unmet fallback builders |
| thinkGuardReferee (shared) | Think-stream triage |
| agentMentionContract | Freeform ```mention parsing (not a system prompt) |
| sharedSnippets | JSON_ONLY_FINAL_RULE_LINES, JSON_ARRAY_ONLY_LINE, mention note |

## Capability truth (auditor / workers)

- Default **hunk** workers: JSON file edits only.
- **`kind: "build"`** todos and build workers: allowlisted project scripts.
- Auditor rule 8 must describe both paths — never “workers cannot run shell” as a blanket.

## When editing prompts

1. Keep hard output shape near the top of SYSTEM prompts.
2. Prefer user-prompt blocks for optional modes (test-driven, parallel hypothesis, UI snapshot).
3. Bump registry entry version + assertions if the contract changes.
4. Run prompt unit tests + drift check.
