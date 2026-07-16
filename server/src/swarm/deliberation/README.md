# Deliberation: multi-layer reason validation

## Mental model

| Layer | Who | What |
|-------|-----|------|
| **hierarchy** | Blackboard planner / auditor / orchestrator | Higher-up validates worker claims; **approve** ships commits, **deny** rejects |
| **peer** | Council (and other discussion) agents | Peers discuss, challenge, validate each others' reasons; vote tallies **approve** a draft |
| **control** | Stall gate / tool coach | Machine rationales (optional future wire) |

Flow every layer shares:

```
claim (reason) → peer/hierarchy validation → approve | deny
```

All decisions are **transactions** recorded for dissemination.

## Durable log locations

Per run (project clone):

- `logs/<runId>/deliberation.jsonl`
- `logs/<shortId>/deliberation.jsonl` (mirror)

Also:

- Transcript system lines: `[deliberation:peer|hierarchy] APPROVE|DENY · …`
- WS event: `deliberation_transaction`
- Debug: `logDiag` type `deliberation_transaction`

## Agent envelopes

### Peer freeform (discussion drafts)

```deliberate
subject: <what is decided>
claim: <their reason>
stance: approve | deny | challenge | validate
why: <your validation reason>
evidence: file1.ts, file2.ts
to: agent-2
```

Injected automatically on discussion draft prompts.

### Hierarchy (blackboard)

Auditor hunk review already produces approve/deny; those are written as hierarchy transactions (no extra envelope required).

### Peer vote (council)

`councilReconcile: "vote"` ballots + winner tally write peer transactions with rationales.

## Export / dissemination

```ts
import { readDeliberationLog } from "./deliberationLog.js";
const rows = await readDeliberationLog(clonePath, runId);
// → feed Brain, next-run context, or external analytics
```

## Related knobs

- `mentionContracts` — inter-agent asks (orthogonal; routing work)
- `councilReconcile: "vote" | "judge"` — structured peer selection
- Auditor pending-commit gate — hierarchy ship authority
