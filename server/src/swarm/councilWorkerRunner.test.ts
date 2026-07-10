import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "councilWorkerRunner.ts"), "utf8");

test("councilWorkerRunner marks thinking before todo prompt and ready after", () => {
  assert.match(SRC, /setWorkerThinking\(state, agent\)/, "must mark thinking when a todo starts");
  assert.match(SRC, /setWorkerReady\(state, agent\)/, "must mark ready when a todo finishes");
  assert.match(SRC, /thinkingSince/, "thinking status must include thinkingSince for sidebar ticker");
});

test("councilWorkerRunner — literature research + web tools profile", () => {
  assert.match(SRC, /runCouncilLiteratureResearch/, "must run literature pre-pass for research todos");
  assert.match(SRC, /isLiteratureTodo/, "must detect literature todos");
  assert.match(SRC, /LITERATURE_RESEARCH_PROFILE/, "must use web-only literature profile");
  assert.match(SRC, /LITERATURE_RESEARCH_TOOLS/, "must restrict literature tools to web only");
  assert.match(SRC, /LITERATURE_RESEARCH_NUDGE_TURN/, "must nudge at turn 25 to emit prose");
  assert.match(SRC, /isUsableResearchBrief/, "must reject JSON hunks and intent-only stubs");
  assert.match(SRC, /activity: \{ kind: "worker"/, "must label worker todo prompts");
  assert.match(SRC, /researchNotes/, "must pass research notes into worker prompt");
});

test("councilWorkerRunner — buffers tool trace on agent bubbles (not per-call system lines)", () => {
  assert.match(SRC, /makeBufferedToolHandler/, "must buffer tool invocations");
  assert.doesNotMatch(SRC, /makeWebToolHandler/, "must not emit per-tool transcript spam");
  assert.match(SRC, /state\.pendingToolTraceByAgent/, "must share pending trace map with CouncilRunner");
});

test("councilWorkerRunner — preserves worker skip reason", () => {
  assert.match(SRC, /skip\(todo\.id, result\.reason\)/, "must store actual skip reason on todo");
});

test("councilWorkerRunner — routes build todos through executeCouncilBuildTodo", () => {
  assert.match(SRC, /executeCouncilBuildTodo/, "must handle build-style todos");
  assert.match(SRC, /todo\.kind === "build"/, "must branch on build kind");
  assert.match(SRC, /checkBuildCommand/, "must enforce build command allowlist");
});

test("councilWorkerRunner — persists worker JSON to transcript via appendAgent", () => {
  assert.match(SRC, /state\.appendAgent\(agent, res\)/, "must append primary worker response");
  assert.match(SRC, /state\.appendAgent\(agent, repairText\)/, "must append hunk-repair response");
});

test("councilWorkerRunner — retry messages include real failure reasons", () => {
  assert.doesNotMatch(SRC, /parse failed — trying repair/, "must not use generic parse-failed label");
  assert.match(SRC, /primary failed \(\$\{primaryReason\}\) — trying repair prompt/, "stage 2 names primary failure");
  assert.match(SRC, /repair failed \(\$\{repairReason\}\) — trying failover model/, "stage 3 names repair failure");
  assert.match(SRC, /summarizeWorkerFailureReason/, "must summarize reasons for transcript");
});

test("councilWorkerRunner — stage 2 uses buildWorkerRepairPrompt (not duplicate primary)", () => {
  assert.match(SRC, /buildWorkerRepairPrompt/, "must import JSON repair prompt builder");
  assert.match(SRC, /repairFrom/, "must pass prior response into repair attempt");
  assert.match(SRC, /repairAndParseJson/, "must lenient-parse before declaring JSON failure");
  assert.doesNotMatch(SRC, /tryBrainFallback/i, "worker recovery stays in swarm agents, not in-run brain");
});

test("councilWorkerRunner — stage-3 failover uses providerFailover chain", () => {
  assert.match(SRC, /councilWorkerFallbackModel/, "must resolve fallback from failover chain");
  assert.match(SRC, /state\.cfg\.providerFailover/, "must pass per-run providerFailover");
  assert.match(SRC, /withSiblingRetry/, "must swap model for failover attempt");
});

test("councilWorkerRunner — file-scoped dequeue defers overlapping writers", () => {
  assert.match(SRC, /dequeueCouncilTodo/, "must use council dequeue with file deferral");
  assert.match(SRC, /scoreCouncilTodoForDequeue/, "must score todos for overlap and build-last");
  assert.match(SRC, /WORKER_DEFER_POLL_MS/, "must poll when todos are deferred but still pending");
});

test("councilWorkerRunner — reports settle agent id for cycle settlement", () => {
  assert.match(SRC, /onTodoSettledByAgent/, "must notify settlement with agent id");
});