import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { RepoService } from "../services/RepoService.js";
import type { SwarmEvent } from "../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";

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
    spawnAgentNoOpencode: async (opts: any) => {
      const agent = makeMockAgent(`agent-${opts.index}`, opts.index, opts.model);
      agents.set(agent.id, agent);
      agentStates.set(agent.id, { id: agent.id, index: agent.index, status: "ready" });
      return agent;
    },
    spawnHousekeeperAgent: async (cwd: string) => {
      const agent = makeMockAgent("agent-0", 0, "monitor");
      agents.set(agent.id, agent);
      agentStates.set(agent.id, { id: agent.id, index: agent.index, status: "ready" });
      return agent;
    },
    killAll: async () => ({ portsReleased: 0 }),
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
    ensureGitRepo: async () => ({ initialized: false }),
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

class TestRunner extends DiscussionRunnerBase {
  startCalled = false;
  startConfig: RunConfig | null = null;
  protected getPresetName(): string { return "Test"; }

  async start(cfg: RunConfig): Promise<void> {
    this.startCalled = true;
    this.startConfig = cfg;
    this.resetState(cfg);
  }

  getPhase(): string { return this.phase; }
  getRound(): number { return this.round; }
  getTranscript() { return this.transcript; }
  getStopping() { return this.stopping; }
  getActive() { return this.active; }
}

function makeRunner(): { runner: TestRunner; events: SwarmEvent[]; manager: Record<string, any>; repos: Record<string, any> } {
  const { opts, events, manager, repos } = makeMockOpts();
  const runner = new TestRunner(opts);
  return { runner, events, manager, repos };
}

const MINIMAL_CFG: RunConfig = {
  agentCount: 1,
  rounds: 1,
  model: "test-model",
  preset: "round-robin",
  repoUrl: "https://github.com/test/repo",
  localPath: "/tmp/test-repo",
  userDirective: "test directive",
};

describe("DiscussionRunnerBase — lifecycle methods", () => {
  describe("isRunning()", () => {
    it("returns false in idle phase", () => {
      const { runner } = makeRunner();
      assert.equal(runner.isRunning(), false);
      assert.equal(runner.getPhase(), "idle");
    });

    it("returns true in discussing phase", () => {
      const { runner } = makeRunner();
      runner.start(MINIMAL_CFG);
      runner.setPhase("discussing");
      assert.equal(runner.isRunning(), true);
      assert.equal(runner.getPhase(), "discussing");
    });

    it("returns true in planning phase", () => {
      const { runner } = makeRunner();
      runner.setPhase("planning");
      assert.equal(runner.isRunning(), true);
      assert.equal(runner.getPhase(), "planning");
    });

    it("returns true in spawning phase", () => {
      const { runner } = makeRunner();
      runner.setPhase("spawning");
      assert.equal(runner.isRunning(), true);
      assert.equal(runner.getPhase(), "spawning");
    });

    it("returns false in stopped phase", () => {
      const { runner } = makeRunner();
      runner.setPhase("stopped");
      assert.equal(runner.isRunning(), false);
      assert.equal(runner.getPhase(), "stopped");
    });

    it("returns false in completed phase", () => {
      const { runner } = makeRunner();
      runner.setPhase("completed");
      assert.equal(runner.isRunning(), false);
      assert.equal(runner.getPhase(), "completed");
    });

    it("returns false in failed phase", () => {
      const { runner } = makeRunner();
      runner.setPhase("failed");
      assert.equal(runner.isRunning(), false);
    });
  });

  describe("setPhase()", () => {
    it("updates phase and emits swarm_state event", () => {
      const { runner, events } = makeRunner();
      runner.setPhase("cloning");
      assert.equal(runner.getPhase(), "cloning");
      const stateEvent = events.find((e) => e.type === "swarm_state");
      assert.ok(stateEvent);
      if (stateEvent && stateEvent.type === "swarm_state") {
        assert.equal(stateEvent.phase, "cloning");
        assert.equal(stateEvent.round, 0);
      }
    });

    it("emits round from current state", () => {
      const { runner, events } = makeRunner();
      runner.start(MINIMAL_CFG);
      events.length = 0;
      runner.setPhase("discussing");
      const stateEvent = events.find((e) => e.type === "swarm_state");
      assert.ok(stateEvent);
    });
  });

  describe("injectUser()", () => {
    it("adds a user transcript entry and emits it", () => {
      const { runner, events } = makeRunner();
      runner.injectUser("Add error handling");
      assert.equal(runner.getTranscript().length, 2);
      assert.equal(runner.getTranscript()[0].role, "user");
      assert.equal(runner.getTranscript()[0].text, "Add error handling");
      const transcriptEvent = events.find((e) => e.type === "transcript_append");
      assert.ok(transcriptEvent);
    });

    it("adds a system receipt after the user message", () => {
      const { runner } = makeRunner();
      runner.injectUser("Do something");
      assert.equal(runner.getTranscript()[1].role, "system");
      assert.ok(runner.getTranscript()[1].text.includes("receipt"));
    });

    it("passes intent and targetAgent to the transcript entry", () => {
      const { runner, events } = makeRunner();
      runner.injectUser("Think about this", { intent: "ask", targetAgent: "agent-1" });
      const userEntry = runner.getTranscript()[0];
      assert.equal((userEntry as any).intent, "ask");
      assert.equal((userEntry as any).targetAgent, "agent-1");
    });

    it("defaults intent to 'steer' when not provided", () => {
      const { runner } = makeRunner();
      runner.injectUser("Test");
      const userEntry = runner.getTranscript()[0];
      assert.equal((userEntry as any).intent, "steer");
    });
  });

  describe("appendSystem()", () => {
    it("appends a system transcript entry and emits it", () => {
      const { runner, events } = makeRunner();
      runner.appendSystem("Test message");
      assert.equal(runner.getTranscript().length, 1);
      assert.equal(runner.getTranscript()[0].role, "system");
      assert.equal(runner.getTranscript()[0].text, "Test message");
      const transcriptEvent = events.find((e) => e.type === "transcript_append");
      assert.ok(transcriptEvent);
    });

    it("accepts a summary parameter", () => {
      const { runner } = makeRunner();
      const summary = { kind: "worker_hunks" as const, hunkCount: 3, ops: { replace: 2, create: 1, append: 0 }, multipleFiles: false, totalChars: 100 };
      runner.appendSystem("Applied hunks", summary);
      assert.ok(runner.getTranscript()[0].summary);
    });

    it("appendSystemMessage delegates to appendSystem for brain suggestions", () => {
      const { runner, events } = makeRunner();
      const summary = { kind: "brain_suggestion" as const, title: "Test" };
      runner.appendSystemMessage?.("Brain suggests X", summary);
      assert.equal(runner.getTranscript().length, 1);
      assert.equal(runner.getTranscript()[0].text, "Brain suggests X");
      const ev = events.find((e: any) => e.type === "transcript_append");
      assert.ok(ev);
    });
  });

  describe("stop()", () => {
    it("sets stopping flag, transitions to stopping then stopped, and kills all agents", async () => {
      const { runner, events, manager } = makeRunner();
      runner.start(MINIMAL_CFG);
      runner.setPhase("discussing");
      events.length = 0;

      await runner.stop();

      assert.equal(runner.getStopping(), true);
      assert.equal(runner.getPhase(), "stopped");

      const stateEvents = events.filter((e) => e.type === "swarm_state");
      const phases = stateEvents.map((e) => (e as any).phase);
      assert.ok(phases.includes("stopping"), "should emit stopping phase");
      assert.ok(phases.includes("stopped"), "should emit stopped phase");
    });

    it("emits transcript_append for kill result", async () => {
      const { runner, events } = makeRunner();
      runner.start(MINIMAL_CFG);
      await runner.stop();

      const transcriptEvents = events.filter((e) => e.type === "transcript_append");
      assert.ok(transcriptEvents.length >= 1, "should emit at least one transcript entry (kill result)");
    });
  });

  describe("status()", () => {
    it("returns SwarmStatus with current state", () => {
      const { runner } = makeRunner();
      runner.start(MINIMAL_CFG);
      const status = runner.status();
      assert.equal(status.phase, "idle");
      assert.equal(status.round, 0);
    });

    it("includes repoUrl and localPath from active config", () => {
      const { runner } = makeRunner();
      runner.start(MINIMAL_CFG);
      const status = runner.status();
      assert.equal(status.repoUrl, MINIMAL_CFG.repoUrl);
      assert.equal(status.localPath, MINIMAL_CFG.localPath);
    });
  });

  describe("resetState()", () => {
    it("clears transcript, round, and resets state", () => {
      const { runner } = makeRunner();
      runner.start(MINIMAL_CFG);
      runner.appendSystem("First message");
      runner.setPhase("discussing");

      runner.start(MINIMAL_CFG);
      assert.equal(runner.getTranscript().length, 0);
      assert.equal(runner.getRound(), 0);
      assert.equal(runner.getActive()?.preset, "round-robin");
    });

    it("resets stopping flag to false", () => {
      const { runner } = makeRunner();
      (runner as any).stopping = true;
      runner.start(MINIMAL_CFG);
      assert.equal(runner.getStopping(), false);
    });

    it("resets summaryWritten flag to false", () => {
      const { runner } = makeRunner();
      (runner as any).summaryWritten = true;
      runner.start(MINIMAL_CFG);
      assert.equal((runner as any).summaryWritten, false);
    });
  });
});

describe("SwarmRunner interface — SwarmRunner.ts types", () => {
  it("PresetId accepts all known presets", () => {
    const presets: string[] = [
      "round-robin",
      "blackboard",
      "role-diff",
      "council",
      "orchestrator-worker",
      "orchestrator-worker-deep",
      "debate-judge",
      "map-reduce",
      "stigmergy",
      "baseline",
      "moa",
      "pipeline",
    ];
    assert.equal(presets.length, 12);
  });

  it("RunConfig has required fields", () => {
    const cfg: RunConfig = {
      agentCount: 3,
      rounds: 5,
      model: "gemma4",
      preset: "council",
      repoUrl: "https://github.com/example/repo",
      localPath: "/tmp/repo",
      userDirective: "Build a REST API",
    };
    assert.equal(cfg.agentCount, 3);
    assert.equal(cfg.rounds, 5);
    assert.equal(cfg.preset, "council");
  });

  it("RunnerOpts requires manager, repos, emit", () => {
    const { opts } = makeMockOpts();
    assert.ok(opts.manager);
    assert.ok(opts.repos);
    assert.equal(typeof opts.emit, "function");
  });
});

describe("DiscussionRunnerBase — initCloneAndSpawn", () => {
  it("transitions through cloning and spawning phases", async () => {
    const { runner, events } = makeRunner();
    runner.start(MINIMAL_CFG);
    events.length = 0;

    const result = await runner.initCloneAndSpawn(MINIMAL_CFG, {
      preset: "round-robin",
      roleResolver: (a) => "agent",
    });

    assert.ok(result.destPath);
    assert.ok(result.ready.length >= 1);

    const stateEvents = events.filter((e) => e.type === "swarm_state").map((e) => (e as any).phase);
    assert.ok(stateEvents.includes("cloning"), "should emit cloning phase");
    assert.ok(stateEvents.includes("spawning"), "should emit spawning phase");
  });

  it("emits clone_state event with repo details", async () => {
    const { runner, events } = makeRunner();
    runner.start(MINIMAL_CFG);
    events.length = 0;

    await runner.initCloneAndSpawn(MINIMAL_CFG, {
      preset: "round-robin",
      roleResolver: (a) => "agent",
    });

    const cloneEvent = events.find((e) => e.type === "clone_state");
    assert.ok(cloneEvent, "should emit clone_state event");
  });

  it("emits transcript_append for clone message and agents ready", async () => {
    const { runner, events } = makeRunner();
    runner.start(MINIMAL_CFG);
    events.length = 0;

    await runner.initCloneAndSpawn(MINIMAL_CFG, {
      preset: "round-robin",
      roleResolver: (a) => "agent",
    });

    const transcriptEvents = events.filter((e) => e.type === "transcript_append");
    assert.ok(transcriptEvents.length >= 2, "should emit clone message and agents ready message");
  });

  it("throws when no agents start and minAgents > 1", async () => {
    const { opts, events } = makeMockOpts();
    (opts.manager as any).spawnAgentNoOpencode = async () => {
      throw new Error("spawn failed");
    };
    const runner = new TestRunner(opts);

    const cfg = { ...MINIMAL_CFG, agentCount: 3 };
    try {
      await runner.initCloneAndSpawn(cfg, {
        preset: "council",
        minAgents: 2,
        roleResolver: (a) => "councilor",
      });
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.ok(err.message.includes("at least 2 agents"), `unexpected error message: ${err.message}`);
    }
  });
});

describe("DiscussionRunnerBase — emitAgentState", () => {
  it("delegates to manager.recordAgentState", () => {
    const { runner, manager } = makeRunner();
    runner.emitAgentState({
      id: "agent-1",
      index: 0,
      status: "thinking",
    });
    const recorded = manager.toStates().find((s: any) => s.id === "agent-1");
    assert.ok(recorded, "agent state should be recorded");
    assert.equal(recorded.status, "thinking");
  });
});