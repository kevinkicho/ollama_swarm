# Implementation plans — 4 remaining heavy items

> Detailed pickup-cold implementation plans for the 4 items still
> deferred after T199. Each plan covers: substrate changes, phased
> implementation, test strategy, failure modes, decisions to make,
> and per-phase effort estimates.
>
> Order in this doc matches the recommended pickup order (cheapest +
> highest-leverage first).

---

## Item 1: Parallel-clone-to-K-subdirs baseline (1.5-2 days)

### What ships today (T199 sequential K-attempt)

- `BaselineRunner.start` runs K attempts SEQUENTIALLY against ONE clone
- Each attempt: prompt → parse → optional self-critique → score
- Winner = highest score (hunks count + critique-passed bonus)
- Apply ONLY the winner's hunks; commit; done
- Wall-clock = K × per-attempt time

### What this plan delivers

- K attempts run IN PARALLEL, each in its own clone subdir
- Per-attempt verify gate (when `cfg.verifyCommand` set) included in scoring
- Winner picked across K parallel results; cleanup loser subdirs
- Wall-clock ≈ max(per-attempt time) instead of sum

### Substrate changes

**New files:**

- `server/src/swarm/BaselineSwarmHarness.ts` — composes K `BaselineRunner` instances; not itself a `SwarmRunner` (the harness IS the runner the orchestrator sees).

**Modified files:**

- `server/src/services/RepoService.ts` — add `cloneToSubdir({parent, baseName, attemptIdx})` returning `{destPath}`. Picks a path like `<parent>/<baseName>-attempt-<idx>` and clones into it. Reuses the existing clone() guts (don't duplicate the GITHUB_TOKEN injection / force handling).
- `server/src/services/Orchestrator.ts:buildRunner` — when `cfg.preset === "baseline" && (cfg.baselineAttempts ?? 1) > 1`, instantiate `BaselineSwarmHarness` instead of `BaselineRunner`. Single edit; one new branch.

**Interfaces (new):**

```ts
// In BaselineSwarmHarness.ts
interface AttemptResult {
  attempt: number;
  destPath: string;
  hunksApplied: number;
  commitSha: string | null;
  verifyPassed: boolean | null;
  score: number;
  cleanupNeeded: boolean;  // true unless this is the winner
}
```

### Phased implementation

**Phase A: RepoService.cloneToSubdir (0.5 day)**

```ts
async cloneToSubdir(input: {
  parent: string;
  baseName: string;
  attemptIdx: number;
  url: string;
}): Promise<{destPath: string}> {
  const destPath = path.join(input.parent, `${input.baseName}-attempt-${input.attemptIdx}`);
  // Reject if already exists (don't accidentally reuse a stale subdir)
  await fs.rm(destPath, { recursive: true, force: true });
  // Reuse this.clone() — same GITHUB_TOKEN injection, same force handling
  const result = await this.clone({ url: input.url, destPath });
  return { destPath };
}
```

Tests: clone-to-subdir with mock URL; assert path shape; assert idempotency (re-clone overwrites).

**Phase B: BaselineSwarmHarness skeleton (0.5 day)**

```ts
export class BaselineSwarmHarness implements SwarmRunner {
  // Same SwarmRunner interface; orchestrator can't tell the difference.
  // Internally composes K BaselineRunners.

  async start(cfg: RunConfig): Promise<void> {
    const K = Math.max(1, Math.min(5, cfg.baselineAttempts ?? 1));
    if (K === 1) {
      // Fall back to plain BaselineRunner; no parallel needed.
      const single = new BaselineRunner(this.opts);
      return single.start(cfg);
    }

    this.appendSystem(`[T199 parallel-clone baseline] K=${K} attempts in K subdirs.`);
    // Phase B body: clone to K subdirs in parallel
    const baseName = path.basename(cfg.localPath);
    const parent = path.dirname(cfg.localPath);
    const cloneResults = await Promise.all(
      Array.from({length: K}, (_, i) =>
        this.opts.repos.cloneToSubdir({
          parent, baseName, attemptIdx: i + 1, url: cfg.repoUrl,
        })
      )
    );
    // ... (next phases)
  }
}
```

**Phase C: K runners in parallel + collect results (0.5 day)**

```ts
// Continue Phase B body:
const attemptResults: AttemptResult[] = await Promise.all(
  cloneResults.map(async ({destPath}, i) => {
    const attemptCfg: RunConfig = {
      ...cfg,
      localPath: destPath,
      // Force baselineAttempts=1 so the inner runner doesn't try to
      // multi-attempt within its subdir.
      baselineAttempts: 1,
    };
    const inner = new BaselineRunner(this.opts);
    await inner.start(attemptCfg);
    // BaselineRunner doesn't expose hunksApplied directly today; need
    // to add a getResult() method or scrape from inner.status().transcript.
    const res = inner.getResult(); // NEW method needed (Phase D)
    return {
      attempt: i + 1,
      destPath,
      hunksApplied: res.hunksApplied,
      commitSha: res.commitSha,
      verifyPassed: res.verifyPassed,
      score: res.hunksApplied + (res.verifyPassed === true ? 5 : 0),
      cleanupNeeded: true,  // flipped to false for winner below
    };
  })
);
```

**Phase D: BaselineRunner.getResult() (small refactor)**

Add a public method that exposes the per-attempt outcome without re-parsing the transcript. Easiest: track outcome in a private field as the runner progresses, expose via getResult().

```ts
private result: { hunksApplied: number; commitSha: string | null; verifyPassed: boolean | null } = { hunksApplied: 0, commitSha: null, verifyPassed: null };

getResult(): typeof this.result { return { ...this.result }; }
```

Set the field in the apply/commit branch where applied count is known.

**Phase E: Winner pick + canonical clone migration (0.5 day)**

```ts
// Pick winner: highest score; tie-break by lowest attempt number.
attemptResults.sort((a, b) => b.score - a.score || a.attempt - b.attempt);
const winner = attemptResults[0]!;
attemptResults.forEach(r => { if (r !== winner) r.cleanupNeeded = true; });

// Migrate winner's commits to cfg.localPath (the canonical path the
// user requested). Two paths:
//   (a) Rename winner's subdir to cfg.localPath (cheap; loses canonical
//       path semantics if cfg.localPath was supposed to already exist)
//   (b) Cherry-pick winner's commits into a fresh clone at cfg.localPath
// Pick (a) — simpler, fewer git races. Caveat: cfg.localPath must
// not already exist or be empty (cleanupNeeded should handle this).

await fs.rename(winner.destPath, cfg.localPath);
this.appendSystem(`[T199] winner = attempt ${winner.attempt}/${K} (score=${winner.score}); promoted ${winner.destPath} → ${cfg.localPath}.`);
```

**Phase F: Cleanup loser subdirs (0.5 day)**

```ts
for (const r of attemptResults) {
  if (!r.cleanupNeeded || r === winner) continue;
  // Safety: only delete paths under the parent dir (don't delete
  // arbitrary paths via path manipulation).
  if (!r.destPath.startsWith(parent + path.sep)) {
    this.appendSystem(`[T199] SKIPPED cleanup of ${r.destPath} — outside parent dir`);
    continue;
  }
  try {
    await fs.rm(r.destPath, { recursive: true, force: true });
    this.appendSystem(`[T199] cleaned up loser attempt ${r.attempt}: ${r.destPath}`);
  } catch (err) {
    // Best-effort; don't fail the run on cleanup
    this.appendSystem(`[T199] cleanup failed for attempt ${r.attempt}: ${err}`);
  }
}
```

### Test strategy

- **Unit:** `cloneToSubdir` shape, idempotency.
- **Integration (mocked clone):** K=2 harness with stub `BaselineRunner` that returns deterministic scores; assert winner promotion + loser cleanup.
- **Integration (real clone, small repo):** K=2 against octocat/Hello-World; assert both clones land + winner survives + loser cleaned up.

### Failure modes

| Mode | Mitigation |
|---|---|
| One clone fails (network) | Other K-1 attempts continue; if all fail, harness reports failed |
| Winner promotion fails (cfg.localPath exists) | Detect + delete cfg.localPath first; or fall back to (b) cherry-pick path |
| Cleanup fails (file lock) | Best-effort; log warning, don't fail the run |
| Quota wall during parallel calls | All K attempts get the wall; harness already-failed; reuse the existing pause/probe loop from blackboard's enterPause() |
| Disk full from K full clones | RepoService.clone should already check disk space; if not, document the requirement |

### Decisions to make

1. **Winner promotion: rename vs cherry-pick.** Rename is simpler but loses canonical-path semantics if cfg.localPath was supposed to already exist (resume-on-existing-clone case). Recommend rename for first cut; cherry-pick for v2.
2. **Score formula.** Today T199 uses `hunks + 2*critique`. Add verify-pass weight (suggest +5 since it's a stronger signal). Open: weight verify-fail penalty (currently 0)?
3. **Concurrency cap.** K=5 means 5 parallel Ollama calls; could trip quota walls. Default cap K=3? Document in the cfg field.

### Effort breakdown

- Phase A: 0.5 day
- Phase B + C: 0.5 day  
- Phase D: 0.5 day (small refactor)
- Phase E + F: 0.5 day
- Tests: 0.5 day
- **Total: 1.5-2 days** (matches initial estimate)

---

## Item 2: Parallel debate streams (2-3 days)

### What ships today (T199 parallel proposition rank)

- 3 candidate propositions generated IN PARALLEL via `Promise.all`
- Judge runs ONE rank prompt to pick the winner
- ONE debate runs against the winning proposition

### What this plan delivers

- K full debates run IN PARALLEL, each with a different proposition
- Each stream has its own scoped transcript + PRO/CON state
- Cross-stream judge synthesis picks the BEST verdict (most informative + best-grounded)
- 3× cloud token cost — opt-in via `cfg.parallelDebateStreams` flag

### Substrate changes

**New files:**

- `server/src/swarm/DebateStream.ts` — per-stream state container: scoped transcript, PRO/CON refs, proposition, verdict (when settled).

**Modified files:**

- `server/src/swarm/DebateJudgeRunner.ts` — refactor `runDebaterTurn` + `runJudgeTurn` to accept a `DebateStream` context (not `this.transcript` directly). Top-level loop forks into K parallel `runDebateStream(stream)` calls when flag set.
- `server/src/swarm/SwarmRunner.ts` — new `cfg.parallelDebateStreams: number` field (1-5).
- `server/src/types.ts` — `TranscriptEntry` gains optional `streamId?: string` for UI scoping.

**Interfaces (new):**

```ts
// In DebateStream.ts
export class DebateStream {
  readonly id: string;            // "stream-1", "stream-2", ...
  readonly proposition: string;
  readonly pro: Agent;
  readonly con: Agent;
  // Scoped transcript — a SLICE of the runner's main transcript
  // filtered by streamId. The runner's main transcript still owns
  // every entry (one source of truth); each stream holds a view.
  transcript: TranscriptEntry[] = [];
  verdict: ParsedDebateVerdict | null = null;
}
```

### Phased implementation

**Phase A: DebateStream class + transcript scoping (0.5 day)**

Build `DebateStream` with its own `appendEntry()` that pushes to BOTH the main runner transcript (with `streamId` tag) AND the stream's local view. Why both: the main transcript is the source-of-truth for replay/persistence; the local view is what the prompt builders see.

```ts
class DebateStream {
  appendEntry(runner: DebateJudgeRunner, entry: TranscriptEntry): void {
    const tagged = { ...entry, streamId: this.id };
    runner["transcript"].push(tagged);  // main transcript
    runner["opts"].emit({ type: "transcript_append", entry: tagged });
    this.transcript.push(tagged);       // local view
  }
}
```

Tests: stream isolation (entries from stream-1 don't leak into stream-2's local view); main transcript sees all entries with streamId tags.

**Phase B: Refactor runDebaterTurn + runJudgeTurn to accept stream (1 day)**

Currently these methods read from `this.transcript` directly. Add a `stream: DebateStream` param; read from `stream.transcript` instead. The buildDebaterPrompt + buildJudgePrompt builders also need the stream's transcript (already take a `transcript` param — easy).

```ts
private async runDebaterTurnInStream(
  stream: DebateStream,
  side: "pro" | "con",
  round: number,
  totalRounds: number,
  isFinalRound: boolean,
): Promise<void> {
  const agent = side === "pro" ? stream.pro : stream.con;
  const prompt = buildDebaterPrompt({
    side, round, totalRounds,
    proposition: stream.proposition,
    isFinalRound,
    transcript: stream.transcript,  // SCOPED to this stream
    userDirective: this.active?.userDirective,
  });
  const text = await this.runAgent(agent, prompt);
  stream.appendEntry(this, {
    id: randomUUID(),
    role: "agent",
    agentId: agent.id,
    agentIndex: agent.index,
    text,
    ts: Date.now(),
    summary: { kind: "debate_turn", side, round, streamId: stream.id },
  });
}
```

Tests: a single stream still produces the same output as today's single-stream debate (regression guard).

**Phase C: Top-level loop forks into K parallel streams (0.5 day)**

```ts
// In runDebateJudgeLoop:
const K = Math.max(1, Math.min(5, cfg.parallelDebateStreams ?? 1));
if (K === 1) {
  // Existing single-stream path
  await this.runSingleDebateStream(...);
  return;
}

// K parallel propositions (reuse T199 parallel rank to dedup; pick top K)
const propositions = await this.deriveKParallelPropositions(K);
const streams = propositions.map((p, i) => new DebateStream({
  id: `stream-${i + 1}`,
  proposition: p,
  pro: this.pro,
  con: this.con,
}));

// Run all K streams in parallel
await Promise.all(streams.map(s => this.runDebateStream(s, cfg)));
```

**Decision: agent reuse vs spawn-extra.** PRO + CON are the same 2 agents across all K streams (same model, no per-stream context — each agent's session is per-prompt anyway since blackboard removed sessions in E3 Phase 5). Streams interleave their PRO/CON calls in time; the agent doesn't need to "remember" which stream it's in because each prompt is fully self-contained.

This is the right call — avoids needing 2K agents.

**Phase D: Cross-stream judge synthesis (0.5 day)**

After all K streams complete (each has a verdict), fire ONE cross-stream judge prompt that compares verdicts + picks the most informative + best-grounded.

```ts
private async runCrossStreamJudge(
  judge: Agent,
  streams: DebateStream[],
): Promise<{winnerStreamId: string; rationale: string}> {
  const prompt = buildCrossStreamJudgePrompt({
    streams: streams.map(s => ({
      id: s.id,
      proposition: s.proposition,
      verdict: s.verdict,
    })),
    userDirective: this.active?.userDirective,
  });
  const text = await this.runAgent(judge, prompt);
  return parseCrossStreamPick(text);
}
```

The cross-stream judge prompt asks: "Of these K verdicts, which is the MOST INFORMATIVE? Pick the verdict with strongest grounding + clearest decision-relevant tradeoff."

**Phase E: WS event scoping + tests (0.5 day)**

- `agent_state` events get an optional `streamId` so UI can group panels
- `transcript_append` already passes through `entry.streamId` (the entry shape carries it from Phase A)
- UI is INFORMATIONAL only — doesn't need a UI cutover today; transcript bubbles render in time-order interleaved (functionally fine)

Tests:
- K=2 streams complete independently
- Cross-stream judge picks one
- Transcript entries are tagged correctly
- Single-stream regression (K=1) matches pre-T199 behavior

### Test strategy

- **Unit:** `DebateStream.appendEntry` adds streamId tag to main + local; cross-stream judge prompt parses correctly.
- **Integration (mocked agent):** stub PRO/CON/judge to return deterministic responses; K=2 streams produce 2 verdicts; cross-stream judge picks one.
- **Integration (real agent, single short directive):** K=2 against a small repo; both streams complete; verify K transcript entries tagged correctly.

### Failure modes

| Mode | Mitigation |
|---|---|
| One stream's debater fails | That stream's verdict is null; cross-stream judge sees only the surviving verdicts |
| All streams fail | Harness reports failed; same as today's single-stream all-fail |
| Quota wall during parallel debate calls | All streams pause; reuse blackboard's enterPause() pattern |
| Cross-stream judge can't parse rank | Fall back to first non-null verdict (same as T199 propositions) |

### Decisions to make

1. **K cap.** Default 3? Cap at 5? Each stream costs ~3× a single-stream debate's tokens. Recommend default off, cap 3.
2. **Agent reuse vs 2K extra agents.** Plan above reuses; alternative is 2K agents. Reuse is cheaper + simpler; defend in docstring.
3. **Cross-stream judge: separate agent or reuse JUDGE?** Reuse JUDGE (it's already the rank-picker). Self-evaluation bias is already there from T199's rank step.
4. **Stream proposition source: dedup current parallel-derive output OR force-distinct?** Dedup is current behavior; could add a "force at least K different propositions" loop. Defer the latter.

### Effort breakdown

- Phase A: 0.5 day
- Phase B: 1 day (largest refactor)
- Phase C: 0.5 day
- Phase D: 0.5 day
- Phase E + tests: 0.5 day
- **Total: 3 days** (matches initial estimate's upper bound)

---

## Item 3: In-flight parallel hypothesis (3.5-4 days)

### What ships today (T198i sequential alternatives)

- Planner prompt asks for 2-3 ALTERNATIVE TODOs for unmet/partial criteria
- Tagged `[hypothesis: A/B/C]` in description
- Workers run them SEQUENTIALLY (one at a time via standard dequeue)
- Auditor picks winner by examining commits (no special logic)

### What this plan delivers

- 2-3 alternatives run SIMULTANEOUSLY; first to commit wins
- Other alternatives auto-cancel when winner lands
- Auditor explicitly picks winner + marks losers as `skipped — alternative landed`
- File-conflict detection within group (serialize when alternatives target same files)

### Substrate changes

**Modified files:**

- `server/src/swarm/blackboard/TodoQueue.ts`:
  - Add `groupId?: string` to `QueuedTodo` (and the post() input)
  - Add `markGroupSettled(groupId, winnerId): {skipped: string[]}` method
  - Add `listGroup(groupId): QueuedTodo[]` method
- `server/src/swarm/blackboard/WorkerPipeline.ts`:
  - `applyAndCommit` already uses CAS; when group is settled, the cancel path comes from a SHARED AbortController per group
- `server/src/swarm/blackboard/BlackboardRunner.ts`:
  - When parsing planner output, detect `[hypothesis: X]` tags + assign shared groupId
  - Per-group AbortController map; signal abort to in-flight workers when group settles
  - Conflict detection: if alternatives' expectedFiles overlap, serialize within group (only one alternative active at a time)
- `server/src/swarm/blackboard/prompts/auditor.ts`:
  - Auditor verdict prompt sees group outcomes; explicit "alternative A landed; B/C cancelled" framing

### Phased implementation

**Phase A: TodoQueue groupId schema (0.5 day)**

```ts
// In TodoQueue.ts
export interface QueuedTodo {
  // ... existing fields
  groupId?: string;  // NEW
}

post(input: PostTodoInput & {groupId?: string}): string {
  // ... existing logic
  // Store groupId on the todo
}

listGroup(groupId: string): QueuedTodo[] {
  return this.list().filter(t => t.groupId === groupId);
}

markGroupSettled(groupId: string, winnerId: string): {skipped: string[]} {
  const skipped: string[] = [];
  for (const t of this.listGroup(groupId)) {
    if (t.id === winnerId) continue;
    if (t.status === "completed" || t.status === "failed") continue;
    this.skip(t.id, `alternative ${winnerId} landed first`);
    skipped.push(t.id);
  }
  return { skipped };
}
```

Tests: groupId persists through dequeue/complete; markGroupSettled skips losers + leaves winner intact.

**Phase B: Per-group AbortController + cross-cancellation (0.5 day)**

```ts
// In BlackboardRunner.ts
private groupAborts = new Map<string, AbortController>();

// When dequeuing a todo with groupId:
const groupAbort = this.groupAborts.get(todo.groupId!);
const abortSignal = groupAbort?.signal;
// Pass abortSignal into the worker pipeline + provider call

// When a worker commits successfully:
if (todo.groupId) {
  const result = this.todoQueue.markGroupSettled(todo.groupId, todo.id);
  this.appendSystem(`[T199 hypothesis] group ${todo.groupId} settled: winner=${todo.id}; cancelled ${result.skipped.length} alternative(s).`);
  // Abort in-flight alternative workers
  this.groupAborts.get(todo.groupId)?.abort();
  this.groupAborts.delete(todo.groupId);
}
```

Tests: when one todo in a group commits, the other alternatives' AbortControllers fire; the in-flight workers see the signal + bail cleanly.

**Phase C: Hypothesis-tag parsing in planner output (1 day)**

```ts
// In BlackboardRunner.ts (where planner todos are parsed):
const hypothesisRe = /\[hypothesis:\s*([A-Z])\s*\]/i;
const groupSeed = randomUUID();  // one shared groupId per planner cycle
const todoGroupings = new Map<string, string>(); // todoId → groupId

for (const t of plannerTodos) {
  const match = t.description.match(hypothesisRe);
  if (match) {
    // All alternatives in this planner cycle share the same groupId
    // (planner is asked to emit alternatives together — they're a group
    // by virtue of being co-emitted with hypothesis tags)
    todoGroupings.set(t.id, groupSeed);
  }
}

// Pass groupId into todoQueue.post()
for (const t of plannerTodos) {
  this.todoQueue.post({
    ...t,
    groupId: todoGroupings.get(t.id),
  });
}

// Initialize the group's AbortController
if (Array.from(todoGroupings.values()).includes(groupSeed)) {
  this.groupAborts.set(groupSeed, new AbortController());
}
```

Tests: planner emits 3 hypothesis-tagged todos; all 3 get the same groupId; groupAborts has 1 entry.

**Phase D: Conflict detection within group (0.5 day)**

When dequeuing for a worker, check: is there ANOTHER alternative in the same group that's already in-progress AND touches overlapping files? If yes, defer this todo (don't dispatch yet — wait for the in-progress one to finish or abort).

```ts
// In dequeue logic:
if (todo.groupId) {
  const groupTodos = this.todoQueue.listGroup(todo.groupId);
  const inProgress = groupTodos.filter(t => t.status === "in_progress" && t.id !== todo.id);
  for (const ip of inProgress) {
    const overlap = ip.expectedFiles.some(f => todo.expectedFiles.includes(f));
    if (overlap) {
      // Defer — re-queue this todo
      this.appendSystem(`[T199 hypothesis] deferring ${todo.id} — alternative ${ip.id} in-progress with overlapping files`);
      return null;  // worker waits
    }
  }
}
```

Tests: 3 alternatives with overlapping files; only 1 dispatches at a time; non-overlapping alternatives dispatch in parallel.

**Phase E: Auditor sees group outcomes (0.5 day)**

Modify the auditor prompt builder to surface group outcomes:

```ts
// In auditor.ts
const groupOutcomesBlock = groups.length > 0
  ? [
      "**HYPOTHESIS GROUPS (T199 in-flight parallel):**",
      ...groups.map(g => `- Group ${g.id}: alternative ${g.winnerId} landed; alternatives [${g.skippedIds.join(", ")}] cancelled.`),
      "When evaluating the criterion these alternatives targeted, focus on whether the WINNER's commit met the criterion. Don't penalize for the cancelled alternatives — they were correctly culled.",
      "",
    ].join("\n")
  : [];
```

Plumb group outcomes from BlackboardRunner → auditor seed.

Tests: auditor verdict references the winning hypothesis correctly; doesn't double-count cancelled alternatives.

**Phase F: Tests + integration (0.5 day)**

- Mocked planner emits 3 hypothesis-tagged todos
- Workers run in parallel (with controlled timing)
- First to commit triggers group settlement
- Other workers' AbortControllers fire
- Auditor sees the group outcome correctly

### Test strategy

- **Unit:** TodoQueue groupId persistence; markGroupSettled skips losers; listGroup filters correctly.
- **Integration (mocked workers):** 3-alternative group with controlled completion order; assert winner survives + losers skipped.
- **Integration (real prompts, small repo):** planner prompt produces hypothesis-tagged todos; runner dispatches in parallel; auditor verdict references winner.

### Failure modes

| Mode | Mitigation |
|---|---|
| All alternatives fail | Group has no winner; auditor sees "all alternatives failed for criterion X" + replan |
| Alternative aborts mid-write (file partially modified) | WorkerPipeline already has revert-on-verify-failure; reuse same path on abort |
| Two alternatives commit simultaneously | First-to-acquire-CAS wins; second sees stale hashes + fails (existing CAS behavior) |
| Conflict detection causes deadlock | All alternatives wait on each other? Add timeout: if deferred for N minutes, force-dispatch one |

### Decisions to make

1. **Group cap.** Hard-cap at 3 alternatives per group (matches T198i prompt). Otherwise the conflict-detection deferral logic gets pathological.
2. **Cross-cancellation: hard-abort vs let-finish?** Hard-abort saves tokens but may leave half-modified files. Plan above says hard-abort + rely on revert. Open: should we let in-flight workers FINISH their current step + then drop?
3. **Conflict-detection deferral timeout.** If all 3 alternatives target the same file, conflict detection serializes them. Add 5-min deferral cap before force-dispatching one (the rest get cancelled).
4. **Per-cycle vs per-criterion grouping.** Plan above groups by planner cycle (all hypothesis-tagged todos in one cycle = one group). Alternative: group by which criterion they target. Per-criterion is more correct but harder to detect from prompt output. Defer.

### Effort breakdown

- Phase A: 0.5 day
- Phase B: 0.5 day
- Phase C: 1 day (parser + integration)
- Phase D: 0.5 day
- Phase E: 0.5 day
- Phase F: 0.5 day
- **Total: 3.5 days** (matches initial estimate's lower bound)

---

## Item 4: Real adaptive worker pool sizing (4-5 days)

### What ships today (T198c log-only watchdog)

- Watchdog polls TodoQueue every 30s
- Logs `RECOMMEND +N more workers` or `RECOMMEND scale down`
- Doesn't actually spawn or kill agents

### What this plan delivers

- Watchdog actually spawns mid-run when backlog dictates
- Idle workers killed when backlog drains
- Hysteresis: don't oscillate (require sustained signal)
- Cost attribution: new agents' tokens count toward cfg.maxCostUsd
- WS state: new agent slots show up; killed slots disappear cleanly
- Bounded by cfg.adaptiveWorkers.{min, max}

### Substrate changes

**Modified files:**

- `server/src/services/AgentManager.ts`:
  - `spawnAgentNoOpencode` already exists (single-agent spawn)
  - New `killAgent(id): Promise<void>` — graceful: abort in-flight prompt, remove from list, emit `agent_state` with `status: "killed"`
- `server/src/swarm/blackboard/BlackboardRunner.ts`:
  - Replace T198c log-only watchdog body with actual spawn/kill calls
  - Add hysteresis (sustained signal across N polls)
  - Track "agents spawned mid-run" so killAll() doesn't miss them
- `shared/src/types.ts`:
  - `AgentState` already has `status` enum; add `"killed"` variant
- `web/src/state/store.ts`:
  - Handle `agent_state` with `status: "killed"` — remove panel; OR
  - Add new `agent_removed` event — explicit signal

**Interfaces:**

```ts
// AgentManager additions
async killAgent(id: string): Promise<void>;
isSpawning(): boolean;  // prevents concurrent spawn during a kill
```

### Phased implementation

**Phase A: AgentManager.killAgent (1 day)**

The hard part: the agent might be mid-prompt. Need to:
1. Find the in-flight `AbortController` for this agent (if any) + abort
2. Wait for the prompt to settle (or timeout after 10s)
3. Remove from the list
4. Emit `agent_state` with `status: "killed"` so the UI cleans up the panel

```ts
// In AgentManager.ts
private inFlightControllers = new Map<string, AbortController>();
// (Already need to track this to support stop() — may already exist)

async killAgent(id: string): Promise<void> {
  const agent = this.agents.find(a => a.id === id);
  if (!agent) return;
  // Abort in-flight prompt if any
  const ctrl = this.inFlightControllers.get(id);
  if (ctrl) {
    ctrl.abort();
    // Wait briefly for the abort to propagate
    await new Promise(r => setTimeout(r, 500));
  }
  // Remove from list
  this.agents = this.agents.filter(a => a.id !== id);
  // Emit removal
  this.emitAgentState({
    id: agent.id, index: agent.index, port: agent.port,
    sessionId: agent.sessionId, status: "killed",
  });
  // Cleanup PID tracker entry
  this.pidTracker.unregister(agent.id);
}
```

Tests: spawn agent → kill mid-prompt → assert AbortController fired + list updated + agent_state emitted with status:"killed".

**Phase B: WS event handling for killed agents (0.5 day)**

Two design choices:
- (a) Reuse `agent_state` with `status: "killed"` — UI checks status and removes panel
- (b) New event `agent_removed` — cleaner semantically

Recommend (a) — minimal new event types. UI store handles `status === "killed"` by removing the agent from the agents map.

```ts
// In web/src/state/store.ts
case "agent_state":
  if (e.agent.status === "killed") {
    state.agents.delete(e.agent.id);
  } else {
    state.agents.set(e.agent.id, e.agent);
  }
```

Tests: WS replay of `agent_state` with `status:"killed"` removes the panel from the store; main transcript unaffected.

**Phase C: Hysteresis logic in watchdog (0.5 day)**

Replace T198c's instantaneous trigger with a sustained-signal check. Recommendation requires N consecutive polls (default N=2 = 60s).

```ts
// In BlackboardRunner.ts startAdaptiveWorkerWatchdog
private adaptiveSignal = { upPolls: 0, downPolls: 0 };

private startAdaptiveWorkerWatchdog(opts: { min: number; max: number }): void {
  const SUSTAINED = 2;  // polls before acting; 2 × 30s = 60s sustained signal
  this.adaptiveWatchdog = setInterval(async () => {
    const counts = this.todoQueue.counts();
    const totalLive = counts.pending + counts.inProgress;
    const workers = this.opts.manager.list().filter(a => a.index !== 1).length;
    if (totalLive > workers * 2 && workers < opts.max) {
      this.adaptiveSignal.upPolls++;
      this.adaptiveSignal.downPolls = 0;
      if (this.adaptiveSignal.upPolls >= SUSTAINED) {
        await this.scaleUp(opts);
        this.adaptiveSignal.upPolls = 0;
      }
    } else if (totalLive === 0 && workers > opts.min) {
      this.adaptiveSignal.downPolls++;
      this.adaptiveSignal.upPolls = 0;
      if (this.adaptiveSignal.downPolls >= SUSTAINED) {
        await this.scaleDown(opts);
        this.adaptiveSignal.downPolls = 0;
      }
    } else {
      // Reset both — backlog is in the steady-state band
      this.adaptiveSignal.upPolls = 0;
      this.adaptiveSignal.downPolls = 0;
    }
  }, 30_000);
  this.adaptiveWatchdog.unref?.();
}
```

Tests: backlog spikes for 30s + drops → no scale-up (didn't sustain); backlog spikes for 60s+ → scale-up fires.

**Phase D: scaleUp / scaleDown implementation (1 day)**

```ts
private async scaleUp(opts: {min: number; max: number}): Promise<void> {
  const currentWorkers = this.opts.manager.list().filter(a => a.index !== 1);
  if (currentWorkers.length >= opts.max) return;
  const recommendedAdd = Math.min(
    opts.max - currentWorkers.length,
    Math.ceil((this.todoQueue.counts().pending) / 2),
  );
  if (recommendedAdd === 0) return;
  this.appendSystem(`[T199 adaptive] scaling up by ${recommendedAdd} worker(s) (sustained backlog).`);
  // Spawn new workers; pick model from cfg.workerModel ?? cfg.model
  const cfg = this.active!;
  const baseIdx = currentWorkers.length + 2; // existing workers are 2..N+1; planner=1
  for (let i = 0; i < recommendedAdd; i++) {
    try {
      const newAgent = await this.opts.manager.spawnAgentNoOpencode({
        cwd: cfg.localPath,
        index: baseIdx + i,
        model: cfg.workerModel ?? cfg.model,
      });
      this.appendSystem(`[T199 adaptive] spawned worker ${newAgent.index} (${newAgent.id.slice(0, 8)}).`);
    } catch (err) {
      this.appendSystem(`[T199 adaptive] spawn failed: ${err}; will retry next poll.`);
      break;  // don't keep trying if one fails
    }
  }
}

private async scaleDown(opts: {min: number; max: number}): Promise<void> {
  const currentWorkers = this.opts.manager.list().filter(a => a.index !== 1);
  if (currentWorkers.length <= opts.min) return;
  const recommendedKill = currentWorkers.length - opts.min;
  // Pick IDLE workers — ones not in inFlightControllers
  const idleWorkers = currentWorkers.filter(w => !this.opts.manager.isInFlight(w.id));
  if (idleWorkers.length === 0) return;
  const toKill = idleWorkers.slice(0, Math.min(recommendedKill, idleWorkers.length));
  this.appendSystem(`[T199 adaptive] scaling down: killing ${toKill.length} idle worker(s).`);
  for (const w of toKill) {
    await this.opts.manager.killAgent(w.id);
  }
}
```

Tests: scaleUp respects max cap; scaleDown respects min cap; scaleDown only picks idle workers.

**Phase E: killAll integration + cleanup (0.5 day)**

`AgentManager.killAll` already handles the existing list. New mid-run-spawned workers are in the same `this.agents` array, so killAll picks them up automatically. Verify by adding a test.

Add `isInFlight(id): boolean` method needed by scaleDown (basically `inFlightControllers.has(id)`).

**Phase F: Tests + integration (1 day)**

- Spawn during backlog (mocked TodoQueue with 20 pending todos)
- Scale-down when backlog drains (drain TodoQueue → assert workers killed)
- Hysteresis: short backlog spikes don't trigger
- killAll catches mid-run-spawned workers
- Cost attribution: new workers' token usage shows up in tokenTracker

### Test strategy

- **Unit:** killAgent removes from list + aborts controller; hysteresis logic resets correctly.
- **Integration (mocked manager):** stub TodoQueue with controlled counts; assert scaleUp/scaleDown fire at right times.
- **Integration (real spawn, mocked agent):** scale-up actually spawns a new worker; scale-down kills it; final state matches expected.

### Failure modes

| Mode | Mitigation |
|---|---|
| Spawn fails (cold-start congestion) | scaleUp catches the error; logs + retries next poll |
| Kill races with worker dequeue (worker just picked up a todo) | killAgent only fires for IDLE workers (isInFlight check) |
| killAll misses mid-run-spawned workers | Same array → killAll picks them up; verified by test |
| Quota wall during scale-up | scaleUp catches the error from spawnAgentNoOpencode; logs + waits for quota recovery |
| Cost cap exceeded after scale-up | Existing maxCostUsd watchdog already runs; will halt the run |

### Decisions to make

1. **Hysteresis duration.** 60s sustained (2 polls × 30s) is conservative. Could be 90s (3 polls). Defaults are tuneable; document in cfg field.
2. **Scale-down policy.** Plan above kills idle workers immediately when backlog drains. Alternative: keep workers warm for K minutes in case backlog returns. Recommend immediate-kill (cheaper); document the alternative.
3. **scaleUp during in-flight planner.** If the planner is mid-prompt when watchdog wants to scale up, do we wait? Plan above doesn't gate — spawns happen in parallel with planner. Verify no race.
4. **Cost attribution display.** UI's per-agent cost panel needs to show mid-run-spawned workers. Today the panel is built once; will need to react to new agent_state events. Probably already works via the store update — verify.

### Effort breakdown

- Phase A: 1 day (AgentManager.killAgent — non-trivial because of in-flight handling)
- Phase B: 0.5 day
- Phase C: 0.5 day
- Phase D: 1 day (scaleUp + scaleDown)
- Phase E: 0.5 day
- Phase F: 1 day (tests are extensive — needs careful timing control)
- **Total: 4.5 days** (matches initial 3-5 day estimate's middle)

---

## Cross-cutting notes

### Test discipline

Each item's tests should follow the pattern set by T199 work:
- Pure unit tests for parser/builder/scoring helpers (no I/O)
- Integration tests with mocked agents that return deterministic responses
- Best-effort full-run integration ONLY when a small fixture exists (don't require live Ollama in CI)

### Cost discipline

Items 1-3 each multiply cloud token cost by K. Defaults must be off; cfg fields must have caps (max K=3 or 5); UI must show "approx K× normal cost" warning when toggled on.

Item 4's adaptive pool sizing has a different cost shape — it adds workers when backlog warrants, removes when idle. Net effect should be COST-NEUTRAL or slightly positive (adapts to actual demand). The danger is a runaway scale-up loop; the hysteresis + cap address it.

### Pickup order rationale

1. **Parallel-clone baseline FIRST** because it's the cheapest + the eval harness benefits immediately.
2. **Parallel debate streams SECOND** because debate-judge is a load-bearing preset for the scoreboard's analysis-tier comparisons.
3. **In-flight parallel hypothesis THIRD** because it's the highest blackboard quality lever but needs the most blackboard substrate care.
4. **Adaptive worker pool LAST** because it's operational rather than quality-improving — wait until you have a long-horizon workload that visibly suffers from a stuck worker.

### Effort total

- Item 1: 1.5-2 days
- Item 2: 3 days
- Item 3: 3.5 days
- Item 4: 4.5 days
- **Cumulative: 12-13 days of focused work** spread across 1-2 sessions per item.
