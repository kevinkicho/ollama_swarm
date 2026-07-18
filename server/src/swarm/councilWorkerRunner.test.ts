import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "councilWorkerRunner.ts"), "utf8");
const LIT = readFileSync(join(__dirname, "councilWorkerLiterature.ts"), "utf8");
const ATTEMPT = readFileSync(join(__dirname, "councilWorkerAttempt.ts"), "utf8");
const RETRY = readFileSync(join(__dirname, "councilWorkerRetryChain.ts"), "utf8");
const ALL = `${SRC}\n${LIT}\n${ATTEMPT}\n${RETRY}`;

test("councilWorkerRunner marks thinking before todo prompt and ready after", () => {
  assert.match(SRC, /setWorkerThinking\(state, agent\)/, "must mark thinking when a todo starts");
  assert.match(SRC, /setWorkerReady\(state, agent\)/, "must mark ready when a todo finishes");
  assert.match(SRC, /thinkingSince/, "thinking status must include thinkingSince for sidebar ticker");
});

test("councilWorkerRunner — literature research + web tools profile", () => {
  assert.match(SRC, /runCouncilLiteratureResearch|councilWorkerLiterature/, "must use literature pre-pass module");
  assert.match(ALL, /runCouncilLiteratureResearch/, "must define literature pre-pass");
  assert.match(LIT, /isLiteratureTodo/, "must detect literature todos");
  assert.match(LIT, /LITERATURE_RESEARCH_PROFILE/, "must use web-only literature profile");
  assert.match(LIT, /LITERATURE_RESEARCH_TOOLS/, "must restrict literature tools to web only");
  assert.match(LIT, /LITERATURE_RESEARCH_NUDGE_TURN/, "must nudge at turn 25 to emit prose");
  assert.match(LIT, /isUsableResearchBrief/, "must reject JSON hunks and intent-only stubs");
  assert.match(ATTEMPT, /activity: \{ kind: "worker"/, "must label worker todo prompts");
  assert.match(ATTEMPT, /researchNotes/, "must pass research notes into worker prompt");
  assert.match(LIT, /localCatalogNotesOnResearchFail/, "must inject local catalog on blackout/fail");
});

test("councilWorkerRunner — buffers tool trace on agent bubbles (not per-call system lines)", () => {
  assert.match(ALL, /makeBufferedToolHandler/, "must buffer tool invocations");
  assert.doesNotMatch(ALL, /makeWebToolHandler/, "must not emit per-tool transcript spam");
  assert.match(ATTEMPT, /state\.pendingToolTraceByAgent/, "must share pending trace map with CouncilRunner");
});

test("councilWorkerRunner — preserves worker skip reason", () => {
  assert.match(SRC, /skip\(todo\.id, result\.reason\)/, "must store actual skip reason on todo");
});

test("councilWorkerRunner — routes build todos through executeCouncilBuildTodo", () => {
  assert.match(RETRY, /executeCouncilBuildTodo/, "must handle build-style todos");
  assert.match(RETRY, /todo\.kind === "build"/, "must branch on build kind");
  assert.match(RETRY, /checkBuildCommand/, "must enforce build command allowlist");
});

test("councilWorkerRunner — persists worker JSON to transcript via appendAgent", () => {
  assert.match(
    ATTEMPT,
    /state\.appendAgent\(agent, res,\s*\{\s*role:\s*"worker"\s*\}\)/,
    "must append primary worker response with worker finalize role",
  );
  assert.match(
    ATTEMPT,
    /state\.appendAgent\(agent, repairText,\s*\{\s*role:\s*"worker"\s*\}\)/,
    "must append hunk-repair response with worker finalize role",
  );
});

test("councilWorkerRunner — retry messages include real failure reasons", () => {
  assert.doesNotMatch(ALL, /parse failed — trying repair/, "must not use generic parse-failed label");
  // Stage 2 is class-aware: apply_miss → skip same-model re-emit; else JSON/envelope repair.
  assert.match(
    RETRY,
    /primary failed \(\$\{primaryReason\}\) — (?:apply recovery already tried|trying JSON\/envelope repair prompt)/,
    "stage 2 names primary failure with class-aware recovery",
  );
  assert.match(RETRY, /classifyCycleFailReason/, "must branch stage-2 on fail class");
  assert.match(RETRY, /repair failed \(\$\{repairReason\}\) — trying failover model/, "stage 3 names repair failure");
  assert.match(RETRY, /summarizeWorkerFailureReason/, "must summarize reasons for transcript");
});

test("councilWorkerRunner — stage 2 uses buildWorkerRepairPrompt (not duplicate primary)", () => {
  assert.match(ATTEMPT, /buildWorkerRepairPrompt/, "must import JSON repair prompt builder");
  assert.match(RETRY, /repairFrom/, "must pass prior response into repair attempt");
  assert.match(ATTEMPT, /repairAndParseJson/, "must lenient-parse before declaring JSON failure");
  // apply_miss must NOT full re-emit same model (120b thrash); format recovery still uses repairFrom.
  assert.match(RETRY, /skipping same-model re-emit/, "apply misses skip same-model re-emit after grounded recovery");
  assert.doesNotMatch(ALL, /apply-class: fresh-disk re-emit/, "removed thrashy same-model apply re-emit");
  assert.doesNotMatch(ALL, /tryBrainFallback/i, "worker recovery stays in swarm agents, not in-run brain");
});

test("councilWorkerRunner — classifies worker skips (garbage → no_hunks retry)", () => {
  assert.match(ATTEMPT, /classifyWorkerSkip/, "must classify free-text skips");
  assert.match(ATTEMPT, /garbage skip/, "must reject placeholder skip reasons");
});

test("councilWorkerRunner — demotes build→hunks for create-test intent (2964afe8)", () => {
  assert.match(RETRY, /shouldDemoteBuildToHunks/, "must demote misrouted build todos");
  assert.match(RETRY, /demoting build→hunks/, "must log demotion");
  assert.match(RETRY, /build_misroute/, "must label bare runner no-op as build_misroute");
});

test("councilWorkerRunner — stage-3 failover uses providerFailover chain", () => {
  assert.match(RETRY, /councilWorkerFallbackModel/, "must resolve fallback from failover chain");
  assert.match(RETRY, /state\.cfg\.providerFailover/, "must pass per-run providerFailover");
  assert.match(RETRY, /withSiblingRetry/, "must swap model for failover attempt");
});

test("councilWorkerRunner — file-scoped dequeue defers overlapping writers", () => {
  assert.match(SRC, /dequeueCouncilTodo/, "must use council dequeue with file deferral");
  assert.match(SRC, /councilWorkerDequeue/, "dequeue extracted for LOC hygiene + hotspot scoring");
  assert.match(SRC, /WORKER_DEFER_POLL_MS/, "must poll when todos are deferred but still pending");
  assert.match(SRC, /getFileFailStreak/, "must pass hotspot streak into dequeue");
});

test("councilWorkerRunner — reports settle agent id for cycle settlement", () => {
  assert.match(SRC, /onTodoSettledByAgent/, "must notify settlement with agent id");
});

test("councilWorkerRunner — fail-closed when apply writes zero files", () => {
  assert.match(
    ATTEMPT,
    /filesWritten\.length === 0/,
    "must not complete a todo on no-op apply (zero filesWritten)",
  );
  assert.match(
    ATTEMPT,
    /wrote zero files/,
    "zero-write path must surface an explicit retry reason",
  );
});

test("councilWorkerRunner — LOC split into literature/attempt/retry modules", () => {
  assert.match(SRC, /councilWorkerRetryChain/, "runner delegates retry chain");
  assert.match(ATTEMPT, /export async function tryWorkerPrompt/, "tryWorkerPrompt extracted");
  assert.match(LIT, /export async function runCouncilLiteratureResearch/, "literature extracted");
  assert.match(RETRY, /export async function executeTodoWithRetryChain/, "retry chain extracted");
});
