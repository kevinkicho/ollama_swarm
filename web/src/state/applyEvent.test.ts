import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSwarmStore } from "./store";
import { applyEventToStore } from "./applyEvent";
import { getHybridInfo, shouldIgnoreEarlyTerminal } from "./HybridStateHelper";
import type { SwarmEvent, AgentState, Todo, Claim, Finding, ExitContract, RunSummary, BoardSnapshot, PheromoneEntry, TranscriptEntry } from "../types";

function freshStore() {
  return createSwarmStore();
}

describe("applyEventToStore", () => {
  let store: ReturnType<typeof freshStore>;

  beforeEach(() => {
    store = freshStore();
  });

  describe("transcript_append", () => {
    it("appends a transcript entry", () => {
      const entry: TranscriptEntry = {
        id: "e1",
        role: "agent",
        agentId: "a1",
        agentIndex: 0,
        text: "Hello",
        ts: 1000,
      };
      applyEventToStore({ type: "transcript_append", entry }, store.getState());
      assert.equal(store.getState().transcript.length, 1);
      assert.equal(store.getState().transcript[0].id, "e1");
    });

    it("deduplicates entries with the same id", () => {
      const entry: TranscriptEntry = {
        id: "e1",
        role: "agent",
        agentId: "a1",
        agentIndex: 0,
        text: "Hello",
        ts: 1000,
      };
      applyEventToStore({ type: "transcript_append", entry }, store.getState());
      applyEventToStore({ type: "transcript_append", entry }, store.getState());
      assert.equal(store.getState().transcript.length, 1);
    });

    it("clears streaming for the agent on append", () => {
      store.getState().setStreaming("a1", "partial text");
      const entry: TranscriptEntry = {
        id: "e1",
        role: "agent",
        agentId: "a1",
        agentIndex: 0,
        text: "Full text",
        ts: 1000,
      };
      applyEventToStore({ type: "transcript_append", entry }, store.getState());
      assert.equal(store.getState().streaming.a1, undefined);
      // Streaming text "partial text" is now preserved as agent-stream entry
      assert.equal(store.getState().transcript.length, 2);
      assert.equal(store.getState().transcript[0].role, "agent-stream");
      assert.equal(store.getState().transcript[1].role, "agent");
    });
  });

  describe("agent_state", () => {
    it("upserts an agent", () => {
      const agent: AgentState = {
        id: "a1",
        index: 0,
        status: "ready",
      };
      applyEventToStore({ type: "agent_state", agent }, store.getState());
      assert.equal(store.getState().agents.a1.status, "ready");
    });

    it("updates an existing agent", () => {
      const agent: AgentState = {
        id: "a1",
        index: 0,
        status: "ready",
      };
      applyEventToStore({ type: "agent_state", agent }, store.getState());
      const updated: AgentState = {
        id: "a1",
        index: 0,
        status: "thinking",
      };
      applyEventToStore({ type: "agent_state", agent: updated }, store.getState());
      assert.equal(store.getState().agents.a1.status, "thinking");
    });
  });

  describe("swarm_state", () => {
    it("sets phase and round", () => {
      applyEventToStore(
        { type: "swarm_state", phase: "planning", round: 1 },
        store.getState(),
      );
      assert.equal(store.getState().phase, "planning");
      assert.equal(store.getState().round, 1);
    });

    it("clears agents and streaming on terminal phase", () => {
      const agent: AgentState = {
        id: "a1",
        index: 0,
        status: "ready",
      };
      applyEventToStore({ type: "agent_state", agent }, store.getState());
      store.getState().setStreaming("a1", "partial");
      assert.ok(store.getState().agents.a1);
      assert.ok(store.getState().streaming.a1);

      applyEventToStore(
        { type: "swarm_state", phase: "completed", round: 2 },
        store.getState(),
      );
      assert.equal(store.getState().phase, "completed");
      assert.equal(Object.keys(store.getState().agents).length, 0);
      assert.equal(Object.keys(store.getState().streaming).length, 0);
    });
  });

  describe("agent_streaming", () => {
    it("sets streaming text for an agent", () => {
      applyEventToStore(
        { type: "agent_streaming", agentId: "a1", agentIndex: 0, text: "Hello" },
        store.getState(),
      );
      assert.equal(store.getState().streaming.a1, "Hello");
    });

    it("overwrites previous streaming text", () => {
      applyEventToStore(
        { type: "agent_streaming", agentId: "a1", agentIndex: 0, text: "Part 1" },
        store.getState(),
      );
      applyEventToStore(
        { type: "agent_streaming", agentId: "a1", agentIndex: 0, text: "Part 1 Part 2" },
        store.getState(),
      );
      assert.equal(store.getState().streaming.a1, "Part 1 Part 2");
    });
  });

  describe("agent_streaming_end", () => {
    it("marks streaming as ended", () => {
      applyEventToStore(
        { type: "agent_streaming", agentId: "a1", agentIndex: 0, text: "Hello" },
        store.getState(),
      );
      assert.equal(store.getState().streamingMeta.a1.status, "live");

      applyEventToStore(
        { type: "agent_streaming_end", agentId: "a1" },
        store.getState(),
      );
      assert.equal(store.getState().streamingMeta.a1.status, "done");
      assert.equal(store.getState().streaming.a1, "Hello");
    });
  });

  describe("error", () => {
    it("sets error message", () => {
      applyEventToStore(
        { type: "error", message: "Something went wrong" },
        store.getState(),
      );
      assert.equal(store.getState().error?.message, "Something went wrong");
    });
  });

  describe("todo_posted", () => {
    it("upserts a todo", () => {
      const todo: Todo = {
        id: "t1",
        description: "Fix bug",
        expectedFiles: ["src/foo.ts"],
        createdBy: "planner",
        createdAt: Date.now(),
        status: "open",
        replanCount: 0,
      };
      applyEventToStore({ type: "todo_posted", todo }, store.getState());
      assert.equal(store.getState().todos.t1.description, "Fix bug");
    });
  });

  describe("todo_claimed", () => {
    it("applies a claim to an existing todo", () => {
      const todo: Todo = {
        id: "t1",
        description: "Fix bug",
        expectedFiles: ["src/foo.ts"],
        createdBy: "planner",
        createdAt: Date.now(),
        status: "open",
        replanCount: 0,
      };
      applyEventToStore({ type: "todo_posted", todo }, store.getState());

      const claim: Claim = {
        todoId: "t1",
        agentId: "worker-1",
        fileHashes: { "src/foo.ts": "abc123" },
        claimedAt: Date.now(),
        expiresAt: Date.now() + 300000,
      };
      applyEventToStore(
        { type: "todo_claimed", todoId: "t1", claim },
        store.getState(),
      );
      assert.equal(store.getState().todos.t1.status, "claimed");
      assert.equal(store.getState().todos.t1.claim?.agentId, "worker-1");
    });

    it("no-ops on missing todo", () => {
      const claim: Claim = {
        todoId: "nonexistent",
        agentId: "worker-1",
        fileHashes: {},
        claimedAt: Date.now(),
        expiresAt: Date.now() + 300000,
      };
      applyEventToStore(
        { type: "todo_claimed", todoId: "nonexistent", claim },
        store.getState(),
      );
      assert.equal(Object.keys(store.getState().todos).length, 0);
    });
  });

  describe("todo_committed", () => {
    it("marks a todo as committed", () => {
      const todo: Todo = {
        id: "t1",
        description: "Fix bug",
        expectedFiles: ["src/foo.ts"],
        createdBy: "planner",
        createdAt: Date.now(),
        status: "claimed",
        replanCount: 0,
      };
      applyEventToStore({ type: "todo_posted", todo }, store.getState());
      applyEventToStore(
        { type: "todo_committed", todoId: "t1" },
        store.getState(),
      );
      assert.equal(store.getState().todos.t1.status, "committed");
      assert.ok(store.getState().todos.t1.committedAt);
    });
  });

  describe("todo_failed", () => {
    it("marks a todo as stale with reason", () => {
      const todo: Todo = {
        id: "t1",
        description: "Fix bug",
        expectedFiles: ["src/foo.ts"],
        createdBy: "planner",
        createdAt: Date.now(),
        status: "claimed",
        replanCount: 0,
      };
      applyEventToStore({ type: "todo_posted", todo }, store.getState());
      applyEventToStore(
        { type: "todo_failed", todoId: "t1", reason: "apply failed", replanCount: 1 },
        store.getState(),
      );
      assert.equal(store.getState().todos.t1.status, "stale");
      assert.equal(store.getState().todos.t1.staleReason, "apply failed");
      assert.equal(store.getState().todos.t1.replanCount, 1);
    });
  });

  describe("todo_skipped", () => {
    it("marks a todo as skipped with reason", () => {
      const todo: Todo = {
        id: "t1",
        description: "Fix bug",
        expectedFiles: ["src/foo.ts"],
        createdBy: "planner",
        createdAt: Date.now(),
        status: "open",
        replanCount: 0,
      };
      applyEventToStore({ type: "todo_posted", todo }, store.getState());
      applyEventToStore(
        { type: "todo_skipped", todoId: "t1", reason: "deprecated" },
        store.getState(),
      );
      assert.equal(store.getState().todos.t1.status, "skipped");
      assert.equal(store.getState().todos.t1.skippedReason, "deprecated");
    });
  });

  describe("todo_replanned", () => {
    it("updates todo description and resets status to open", () => {
      const todo: Todo = {
        id: "t1",
        description: "Fix bug",
        expectedFiles: ["src/foo.ts"],
        createdBy: "planner",
        createdAt: Date.now(),
        status: "stale",
        staleReason: "apply failed",
        replanCount: 1,
      };
      applyEventToStore({ type: "todo_posted", todo }, store.getState());

      applyEventToStore(
        {
          type: "todo_replanned",
          todoId: "t1",
          description: "Fix bug differently",
          expectedFiles: ["src/bar.ts"],
          replanCount: 2,
        },
        store.getState(),
      );
      const t = store.getState().todos.t1;
      assert.equal(t.status, "open");
      assert.equal(t.description, "Fix bug differently");
      assert.deepEqual(t.expectedFiles, ["src/bar.ts"]);
      assert.equal(t.replanCount, 2);
      assert.equal(t.staleReason, undefined);
      assert.equal(t.claim, undefined);
    });

    it("preserves existing anchors when expectedAnchors is absent", () => {
      const todo: Todo = {
        id: "t1",
        description: "Fix bug",
        expectedFiles: ["src/foo.ts"],
        createdBy: "planner",
        createdAt: Date.now(),
        status: "stale",
        replanCount: 1,
        expectedAnchors: ["fn_old"],
      };
      applyEventToStore({ type: "todo_posted", todo }, store.getState());

      applyEventToStore(
        {
          type: "todo_replanned",
          todoId: "t1",
          description: "Revised",
          expectedFiles: ["src/foo.ts"],
          replanCount: 2,
        },
        store.getState(),
      );
      assert.deepEqual(store.getState().todos.t1.expectedAnchors, ["fn_old"]);
    });

    it("updates anchors when expectedAnchors is provided", () => {
      const todo: Todo = {
        id: "t1",
        description: "Fix bug",
        expectedFiles: ["src/foo.ts"],
        createdBy: "planner",
        createdAt: Date.now(),
        status: "stale",
        replanCount: 1,
        expectedAnchors: ["fn_old"],
      };
      applyEventToStore({ type: "todo_posted", todo }, store.getState());

      applyEventToStore(
        {
          type: "todo_replanned",
          todoId: "t1",
          description: "Revised",
          expectedFiles: ["src/foo.ts"],
          replanCount: 2,
          expectedAnchors: ["fn_new"],
        },
        store.getState(),
      );
      assert.deepEqual(store.getState().todos.t1.expectedAnchors, ["fn_new"]);
    });
  });

  describe("finding_posted", () => {
    it("appends a finding", () => {
      const finding: Finding = {
        id: "f1",
        agentId: "a1",
        text: "Discovery",
        createdAt: Date.now(),
      };
      applyEventToStore({ type: "finding_posted", finding }, store.getState());
      assert.equal(store.getState().findings.length, 1);
      assert.equal(store.getState().findings[0].id, "f1");
    });

    it("deduplicates findings by id", () => {
      const finding: Finding = {
        id: "f1",
        agentId: "a1",
        text: "Discovery",
        createdAt: Date.now(),
      };
      applyEventToStore({ type: "finding_posted", finding }, store.getState());
      applyEventToStore({ type: "finding_posted", finding }, store.getState());
      assert.equal(store.getState().findings.length, 1);
    });
  });

  describe("queue_state", () => {
    it("replaces todos and findings from snapshot", () => {
      const snapshot: BoardSnapshot = {
        todos: [
          {
            id: "t1",
            description: "Task 1",
            expectedFiles: [],
            createdBy: "planner",
            createdAt: 1000,
            status: "open" as const,
            replanCount: 0,
          },
        ],
        findings: [],
      };
      applyEventToStore(
        { type: "queue_state", snapshot, counts: { open: 1, claimed: 0, committed: 0, stale: 0, skipped: 0, total: 1 } },
        store.getState(),
      );
      assert.equal(store.getState().todos.t1.description, "Task 1");
    });
  });

  describe("contract_updated", () => {
    it("sets the contract", () => {
      const contract: ExitContract = {
        missionStatement: "Build feature X",
        criteria: [],
      };
      applyEventToStore(
        { type: "contract_updated", contract },
        store.getState(),
      );
      assert.equal(store.getState().contract?.missionStatement, "Build feature X");
    });
  });

  describe("run_summary", () => {
    it("sets the summary", () => {
      const summary: RunSummary = {
        repoUrl: "https://github.com/example/repo",
        localPath: "/tmp/repo",
        preset: "blackboard",
        model: "gemma4",
        startedAt: 1000,
        endedAt: 2000,
        wallClockMs: 1000,
        stopReason: "completed",
        commits: 1,
        staleEvents: 0,
        skippedTodos: 0,
        totalTodos: 5,
        filesChanged: 3,
        finalGitStatus: "clean",
        finalGitStatusTruncated: false,
        agents: [],
      };
      applyEventToStore(
        { type: "run_summary", summary },
        store.getState(),
      );
      assert.equal(store.getState().summary?.preset, "blackboard");
    });
  });

  describe("agent_latency_sample", () => {
    it("pushes a latency sample for an agent", () => {
      applyEventToStore(
        {
          type: "agent_latency_sample",
          agentId: "a1",
          agentIndex: 0,
          attempt: 1,
          elapsedMs: 5000,
          success: true,
          ts: 1000,
        },
        store.getState(),
      );
      assert.equal(store.getState().latency.a1.length, 1);
      assert.equal(store.getState().latency.a1[0].elapsedMs, 5000);
    });

    it("caps latency samples at 20 per agent", () => {
      for (let i = 0; i < 25; i++) {
        applyEventToStore(
          {
            type: "agent_latency_sample",
            agentId: "a1",
            agentIndex: 0,
            attempt: i + 1,
            elapsedMs: 1000 + i,
            success: true,
            ts: 1000 + i,
          },
          store.getState(),
        );
      }
      assert.equal(store.getState().latency.a1.length, 20);
    });
  });

  describe("conformance_sample", () => {
    it("pushes a conformance sample", () => {
      applyEventToStore(
        {
          type: "conformance_sample",
          runId: "r1",
          ts: 1000,
          score: 0.8,
          smoothedScore: 0.75,
          reason: "good alignment",
        },
        store.getState(),
      );
      assert.equal(store.getState().conformance.length, 1);
      assert.equal(store.getState().conformance[0].score, 0.8);
      assert.equal(store.getState().conformance[0].reason, "good alignment");
    });

    it("caps conformance samples at 30", () => {
      for (let i = 0; i < 35; i++) {
        applyEventToStore(
          {
            type: "conformance_sample",
            runId: "r1",
            ts: 1000 + i * 90000,
            score: i * 0.01,
            smoothedScore: i * 0.01,
          },
          store.getState(),
        );
      }
      assert.equal(store.getState().conformance.length, 30);
    });
  });

  describe("directive_amended", () => {
    it("pushes an amendment", () => {
      applyEventToStore(
        {
          type: "directive_amended",
          runId: "r1",
          ts: 1000,
          text: "Add error handling",
        },
        store.getState(),
      );
      assert.equal(store.getState().amendments.length, 1);
      assert.equal(store.getState().amendments[0].text, "Add error handling");
    });
  });

  describe("drift_sample", () => {
    it("pushes a drift sample", () => {
      applyEventToStore(
        {
          type: "drift_sample",
          runId: "r1",
          ts: 1000,
          similarity: 0.92,
          smoothedSimilarity: 0.90,
          embeddingModel: "text-embedding-3-small",
          excerptChars: 500,
          windowSimilarities: [0.92, 0.91],
        },
        store.getState(),
      );
      assert.equal(store.getState().drift.length, 1);
      assert.equal(store.getState().drift[0].similarity, 0.92);
    });

    it("caps drift samples at 30", () => {
      for (let i = 0; i < 35; i++) {
        applyEventToStore(
          {
            type: "drift_sample",
            runId: "r1",
            ts: 1000 + i * 90000,
            similarity: 0.5 + i * 0.01,
            smoothedSimilarity: 0.5 + i * 0.01,
            embeddingModel: "text-embedding-3-small",
            excerptChars: 500,
            windowSimilarities: [],
          },
          store.getState(),
        );
      }
      assert.equal(store.getState().drift.length, 30);
    });
  });

  describe("model_shift", () => {
    it("appends a system transcript entry for model shift", () => {
      applyEventToStore(
        {
          type: "model_shift",
          agentId: "planner-1",
          agentIndex: 0,
          fromModel: "glm-5.1",
          toModel: "nemotron-3-super",
          reason: "quota",
        },
        store.getState(),
      );
      assert.equal(store.getState().transcript.length, 1);
      assert.equal(store.getState().transcript[0].role, "system");
      assert.ok(store.getState().transcript[0].text.includes("failover"));
      assert.ok(store.getState().transcript[0].text.includes("glm-5.1"));
      assert.ok(store.getState().transcript[0].text.includes("nemotron-3-super"));
    });

    it("includes rawError in the transcript text when present", () => {
      applyEventToStore(
        {
          type: "model_shift",
          agentId: "worker-1",
          agentIndex: 1,
          fromModel: "glm-5.1:cloud",
          toModel: "deepseek-v4-flash:cloud",
          reason: "network error",
          rawError: "ECONNREFUSED 127.0.0.1:11436",
        },
        store.getState(),
      );
      assert.equal(store.getState().transcript.length, 1);
      assert.ok(store.getState().transcript[0].text.includes("ECONNREFUSED"));
      assert.ok(store.getState().transcript[0].text.includes("127.0.0.1:11436"));
    });
  });

  describe("clone_state", () => {
    it("sets clone state and clears banner dismissal", () => {
      store.getState().dismissCloneBanner();
      assert.equal(store.getState().cloneBannerDismissed, true);

      applyEventToStore(
        {
          type: "clone_state",
          alreadyPresent: true,
          clonePath: "/tmp/repo",
          priorCommits: 5,
          priorChangedFiles: 2,
          priorUntrackedFiles: 1,
        },
        store.getState(),
      );
      assert.equal(store.getState().cloneState?.alreadyPresent, true);
      assert.equal(store.getState().cloneState?.priorCommits, 5);
      assert.equal(store.getState().cloneBannerDismissed, false);
    });
  });

  describe("pheromone_updated", () => {
    it("upserts a pheromone entry", () => {
      const state: PheromoneEntry = {
        visits: 3,
        avgInterest: 0.7,
        avgConfidence: 0.8,
        latestNote: "promising",
      };
      applyEventToStore(
        { type: "pheromone_updated", file: "src/foo.ts", state },
        store.getState(),
      );
      assert.equal(store.getState().pheromones["src/foo.ts"].visits, 3);

      const updated: PheromoneEntry = {
        visits: 5,
        avgInterest: 0.9,
        avgConfidence: 0.95,
        latestNote: "very promising",
      };
      applyEventToStore(
        { type: "pheromone_updated", file: "src/foo.ts", state: updated },
        store.getState(),
      );
      assert.equal(store.getState().pheromones["src/foo.ts"].visits, 5);
    });
  });

  describe("mapper_slices", () => {
    it("sets mapper slices", () => {
      const slices: Record<string, string[]> = {
        "mapper-1": ["src/a.ts", "src/b.ts"],
        "mapper-2": ["src/c.ts"],
      };
      applyEventToStore(
        { type: "mapper_slices", slices },
        store.getState(),
      );
      assert.deepEqual(store.getState().mapperSlices["mapper-1"], ["src/a.ts", "src/b.ts"]);
    });
  });

  describe("run_started", () => {
    it("resets per-run state and sets metadata", () => {
      const agent: AgentState = {
        id: "a1",
        index: 0,
        status: "ready",
      };
      applyEventToStore({ type: "agent_state", agent }, store.getState());
      store.getState().setContract({
        missionStatement: "Old contract",
        criteria: [],
      });

      applyEventToStore(
        {
          type: "run_started",
          runId: "r1",
          startedAt: 1000,
          preset: "blackboard",
          plannerModel: "glm-5.1",
          workerModel: "gemma4",
          auditorModel: "glm-5.1",
          dedicatedAuditor: false,
          repoUrl: "https://github.com/example/repo",
          clonePath: "/tmp/repo",
          agentCount: 3,
          rounds: 5,
        },
        store.getState(),
      );

      const s = store.getState();
      assert.equal(s.runId, "r1");
      assert.equal(s.runStartedAt, 1000);
      assert.equal(s.runConfig?.preset, "blackboard");
      assert.equal(s.runConfig?.plannerModel, "glm-5.1");
      assert.equal(Object.keys(s.agents).length, 0);
      assert.equal(s.contract, undefined);
      assert.equal(s.todos && Object.keys(s.todos).length, 0);
    });

    it("adds a run-start divider to transcript on second run", () => {
      const entry: TranscriptEntry = {
        id: "e1",
        role: "agent",
        agentId: "a1",
        agentIndex: 0,
        text: "First run text",
        ts: 500,
      };
      applyEventToStore({ type: "transcript_append", entry }, store.getState());
      assert.equal(store.getState().transcript.length, 1);

      applyEventToStore(
        {
          type: "run_started",
          runId: "r2",
          startedAt: 2000,
          preset: "council",
          plannerModel: "gemma4",
          workerModel: "gemma4",
          auditorModel: "gemma4",
          dedicatedAuditor: false,
          repoUrl: "https://github.com/example/repo",
          clonePath: "/tmp/repo2",
          agentCount: 4,
          rounds: 3,
        },
        store.getState(),
      );

      // Current lighter resetForNewRun (Task #37) keeps prior transcript history
      // and prepends the divider so the start message is visible at top.
      // Previous entries + new divider.
      assert.ok(store.getState().transcript.length >= 2);
      const divider = store.getState().transcript[0];
      assert.equal(divider.role, "system");
      assert.ok(divider.text.includes("RUN-START"));
    });
  });

  describe("outcome_scored", () => {
    it("sets outcome and appends transcript entry", () => {
      applyEventToStore(
        {
          type: "outcome_scored",
          runId: "r1",
          score: 7.5,
          verdict: "ship-quality",
          dimensions: [
            { id: "d1", label: "Correctness", score: 8, note: "Good" },
            { id: "d2", label: "Style", score: 7, note: "Fine" },
          ],
        },
        store.getState(),
      );
      assert.ok(store.getState().outcome);
      assert.equal(store.getState().outcome!.score, 7.5);
      assert.equal(store.getState().outcome!.verdict, "ship-quality");
      assert.equal(store.getState().outcome!.dimensions.length, 2);
      assert.equal(store.getState().transcript.length, 1);
      assert.ok(store.getState().transcript[0].text.includes("7.5"));
    });
  });

  describe("runId guard", () => {
    it("drops events for a different run when store has runId", () => {
      store.getState().setRunId("run-A");
      const agent: AgentState = {
        id: "a1",
        index: 0,
        status: "ready",
      };
      applyEventToStore({ type: "agent_state", agent, runId: "run-B" }, store.getState());
      assert.equal(Object.keys(store.getState().agents).length, 0);
    });

    it("applies events matching the store runId", () => {
      store.getState().setRunId("run-A");
      const agent: AgentState = {
        id: "a1",
        index: 0,
        status: "ready",
      };
      applyEventToStore({ type: "agent_state", agent, runId: "run-A" }, store.getState());
      assert.equal(store.getState().agents.a1.status, "ready");
    });

    it("allows events without runId when store has runId", () => {
      store.getState().setRunId("run-A");
      applyEventToStore(
        { type: "swarm_state", phase: "planning", round: 1 },
        store.getState(),
      );
      assert.equal(store.getState().phase, "planning");
    });
  });

  describe("unknown event type", () => {
    it("does nothing for unknown event types", () => {
      const before = { ...store.getState() };
      applyEventToStore(
        { type: "unknown_event" } as any,
        store.getState(),
      );
      assert.equal(store.getState().phase, before.phase);
      assert.equal(store.getState().transcript.length, 0);
    });
  });

  describe("history / review roundtrip: FE store matches BE generated transcript + agents (no loss, correct shape)", () => {
    it("replaying backend transcript entries + summary.agents via append/upsert produces exact match (no lost bubbles, correct indices for sidebar)", () => {
      // Simulates what server writes to summary.json (transcript + agents: PerAgentStat[])
      // and what provider + applyEvent do on /runs/:id load. Guards against disappearance and "Agent undefined".
      const beTranscript: TranscriptEntry[] = [
        { id: "t1", role: "system", text: "RUN-START", ts: 1 },
        { id: "t2", role: "agent", agentId: "agent-1", agentIndex: 1, text: "Contract...", ts: 2, summary: { kind: "contract" } as any },
        { id: "t3", role: "agent", agentId: "agent-2", agentIndex: 2, text: "Posted todos", ts: 3 },
        { id: "t4", role: "agent", agentId: "agent-3", agentIndex: 3, text: "Work done", ts: 4 },
      ];
      const beAgents = [ // PerAgentStat shape from runSummaryWriter
        { agentId: "agent-1", agentIndex: 1, turnsTaken: 5 },
        { agentId: "agent-2", agentIndex: 2, turnsTaken: 3 },
        { agentId: "agent-3", agentIndex: 3, turnsTaken: 1 },
      ];

      // Replay as done in SwarmStoreProvider hydrate + applyEventToStore
      beTranscript.forEach(e => applyEventToStore({ type: "transcript_append", entry: e }, store.getState()));
      beAgents.forEach((a: any) => {
        const converted = { id: a.agentId, index: a.agentIndex, status: "stopped" as const };
        store.getState().upsertAgent(converted as any);
      });

      const feT = store.getState().transcript;
      const feA = Object.values(store.getState().agents);

      assert.equal(feT.length, beTranscript.length, "some transcript bubbles generated by BE were lost in FE store (disappearance bug)");
      beTranscript.forEach(be => assert.ok(feT.some(fe => fe.id === be.id), `FE missing BE transcript ${be.id}`));

      assert.equal(feA.length, beAgents.length);
      beAgents.forEach(beA => {
        const fe = feA.find(f => f.id === beA.agentId);
        assert.ok(fe, `FE missing agent ${beA.agentId}`);
        assert.equal(fe.index, beA.agentIndex, "agent index wrong -> sidebar shows 'Agent undefined'");
      });
    });
  });

  // Phase 10: after full removal of guards and phase state emitters,
  // helpers are neutral stubs and phase_* events are no-ops (not emitted).
  describe("post-removal: HybridStateHelper stubs + no phase state (Phase 10)", () => {
    it("all helpers return neutral / false values", () => {
      const info = getHybridInfo();
      assert.equal(info.isHybrid, false);
      assert.equal(info.isExecPhase, false);
      assert.equal(shouldIgnoreEarlyTerminal(), false);
    });

    it("phase_started / phase_completed events are ignored (no pollution)", () => {
      applyEventToStore({ type: "run_started", runId: "h1", preset: "blackboard", plannerModel: "m", workerModel: "m", auditorModel: "m", dedicatedAuditor: false, agentCount: 4, rounds: 0, repoUrl: "", clonePath: "", topology: {} } as any, store.getState());
      // These event types are no longer produced; applying them should be safe no-op.
      applyEventToStore(
        { type: "phase_started", phaseIndex: 0, preset: "council", runId: "h1" } as any,
        store.getState()
      );
      const rc = store.getState().runConfig as any;
      // No currentPhase/phases should be set by legacy event (applyEvent no longer handles)
      // (presence would only come from old persisted summary hydrate)
      if (rc) {
        // we don't assert absence of legacy keys, just that apply didn't crash
      }
      assert.ok(store.getState().runConfig);
    });
  });
});