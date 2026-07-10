import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { BlackboardRunner } from "./BlackboardRunner.js";
import type { Agent, AgentManager } from "../../services/AgentManager.js";
import type { RepoService } from "../../services/RepoService.js";
import type { SwarmEvent } from "../../types.js";
import type { RunConfig, RunnerOpts } from "../SwarmRunner.js";

function makeMockAgent(id = "agent-1", index = 0, model = "test-model"): Agent {
  return { id, index, model, sessionId: `session-${id}` } as Agent;
}

function makeMockOpts(): {
  opts: RunnerOpts;
  events: SwarmEvent[];
  manager: Record<string, any>;
  repos: Record<string, any>;
} {
  const events: SwarmEvent[] = [];
  const agentStates: Map<string, any> = new Map();
  const agents: Map<string, Agent> = new Map();

  const manager = {
    spawnAgent: async (o: any) => {
      const agent = makeMockAgent(`agent-${o.index}`, o.index, o.model);
      agents.set(agent.id, agent);
      agentStates.set(agent.id, { id: agent.id, index: agent.index, status: "ready" });
      return agent;
    },
    killAll: async () => {
      agentStates.clear();
      agents.clear();
      return { portsReleased: 0 };
    },
    killAgent: async () => {},
    toStates: () => [...agentStates.values()],
    getPartialStreams: () => ({}),
    recordAgentState: (s: any) => { agentStates.set(s.id, s); },
    markStatus: (id: string, status: string, meta?: any) => {
      const existing = agentStates.get(id);
      if (existing) { existing.status = status; Object.assign(existing, meta ?? {}); }
    },
    recordPromptComplete: () => {},
    list: () => [...agents.values()],
    getWarmupElapsedMs: () => undefined,
  };

  const repos = {
    clone: async () => ({
      destPath: "/tmp/test-repo",
      alreadyPresent: false,
      priorCommits: 0,
      priorChangedFiles: 0,
      priorUntrackedFiles: 0,
    }),
    excludeRunnerArtifacts: async () => {},
    listTopLevel: async () => [],
  };

  const opts: RunnerOpts = {
    manager: manager as unknown as AgentManager,
    repos: repos as unknown as RepoService,
    emit: (e: SwarmEvent) => { events.push(e); },
    logDiag: () => {},
  };

  return { opts, events, manager, repos };
}

const MINIMAL_CFG: RunConfig = {
  agentCount: 1,
  rounds: 1,
  model: "test-model",
  preset: "blackboard",
  repoUrl: "https://github.com/test/repo",
  localPath: "/tmp/test-repo",
  userDirective: "test directive",
};

describe("BlackboardRunner — lifecycle state transitions", () => {
  describe("isRunning()", () => {
    it("returns false in idle phase (initial state)", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      assert.equal(runner.isRunning(), false);
    });

    it("returns true in cloning phase", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "cloning";
      assert.equal(runner.isRunning(), true);
    });

    it("returns true in planning phase", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "planning";
      assert.equal(runner.isRunning(), true);
    });

    it("returns true in executing phase", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "executing";
      assert.equal(runner.isRunning(), true);
    });

    it("returns true in paused phase", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "paused";
      assert.equal(runner.isRunning(), true);
    });

    it("returns true in draining phase", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "draining";
      assert.equal(runner.isRunning(), true);
    });

    it("returns false in stopped phase", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "stopped";
      assert.equal(runner.isRunning(), false);
    });

    it("returns false in completed phase", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "completed";
      assert.equal(runner.isRunning(), false);
    });

    it("returns false in failed phase", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "failed";
      assert.equal(runner.isRunning(), false);
    });
  });

  describe("status()", () => {
    it("returns initial state with idle phase", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      const status = runner.status();
      assert.equal(status.phase, "idle");
      assert.equal(status.round, 0);
    });

    it("reflects phase updates", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "executing";
      (runner as any).round = 3;
      const status = runner.status();
      assert.equal(status.phase, "executing");
      assert.equal(status.round, 3);
    });
  });

  describe("lifecycleState field", () => {
    it("starts as idle", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      assert.equal((runner as any).lifecycleState, "idle");
    });
  });

  describe("stop()", () => {
    it("transitions lifecycleState to stopping then sets phase to stopped", async () => {
      const { opts, events, manager } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "executing";
      (runner as any).lifecycleState = "running";
      (runner as any).active = MINIMAL_CFG;

      await runner.stop();

      assert.equal((runner as any).lifecycleState, "stopping");
      assert.equal((runner as any).phase, "stopped");

      const stateEvents = events.filter((e) => e.type === "swarm_state");
      const phases = stateEvents.map((e: any) => e.phase);
      assert.ok(phases.includes("stopping"), "should emit stopping state");
      assert.ok(phases.includes("stopped"), "should emit stopped state");
    });
  });

  describe("drain()", () => {
    it("sets lifecycleState to draining when claims are in-flight", async () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "executing";
      (runner as any).lifecycleState = "running";
      (runner as any).active = MINIMAL_CFG;
      (runner as any).boardCounts = () => ({ open: 0, claimed: 1, committed: 0, stale: 0, skipped: 0 });

      await runner.drain();

      assert.equal((runner as any)._wasDrained, true);
      assert.equal((runner as any).lifecycleState, "draining");
    });

    it("escalates to stop immediately when drain is not eligible (planning)", async () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "planning";
      (runner as any).lifecycleState = "running";
      (runner as any).active = MINIMAL_CFG;
      (runner as any).boardCounts = () => ({ open: 0, claimed: 0, committed: 0, stale: 0, skipped: 0 });

      await runner.drain();

      assert.equal((runner as any).lifecycleState, "stopping");
    });

    it("does not override stopping state", async () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "stopping";
      (runner as any).lifecycleState = "stopping";
      (runner as any).active = MINIMAL_CFG;

      await runner.drain();

      // Should stay in stopping — drain() is a no-op when already stopping
      assert.equal((runner as any).lifecycleState, "stopping");
    });
  });

  describe("_wasDrained flag", () => {
    it("is false initially", () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      assert.equal((runner as any)._wasDrained, false);
    });

    it("becomes true after drain() is called", async () => {
      const { opts } = makeMockOpts();
      const runner = new BlackboardRunner(opts);
      (runner as any).phase = "executing";
      (runner as any).lifecycleState = "running";
      (runner as any).active = MINIMAL_CFG;
      (runner as any).boardCounts = () => ({ open: 0, claimed: 1, committed: 0, stale: 0, skipped: 0 });

      await runner.drain();
      assert.equal((runner as any)._wasDrained, true);
    });
  });
});