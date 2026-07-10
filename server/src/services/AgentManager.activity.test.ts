import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentManager } from "./AgentManager.js";
import type { AgentState, SwarmEvent } from "../types.js";

describe("AgentManager activity + merge control plane", () => {
  it("recordAgentState merges partial emits without wiping activityLabel", () => {
    const states: AgentState[] = [];
    const mgr = new AgentManager((s) => {
      states.push(s);
    });
    // Seed via markStatus path — simulate thinking with labels
    (mgr as unknown as { agentStates: Map<string, AgentState> }).agentStates.set("agent-1", {
      id: "agent-1",
      index: 1,
      status: "thinking",
      thinkingSince: 100,
      activityLabel: "standup",
      activityKind: "council",
      model: "m",
      sessionId: "s1",
    });
    (mgr as unknown as { agents: Map<string, { id: string; index: number; sessionId: string; model: string; cwd: string }> }).agents.set(
      "agent-1",
      { id: "agent-1", index: 1, sessionId: "s1", model: "m", cwd: "/tmp" },
    );

    mgr.recordAgentState({
      id: "agent-1",
      index: 1,
      sessionId: "s1",
      status: "thinking",
      thinkingSince: 200,
    });

    const mirrored = mgr.getState("agent-1");
    assert.equal(mirrored?.activityLabel, "standup");
    assert.equal(mirrored?.activityKind, "council");
    assert.equal(mirrored?.model, "m");
    assert.equal(mirrored?.thinkingSince, 200);
  });

  it("getActivitySnapshot tracks emitAgentActivity for /status hydrate", () => {
    const events: SwarmEvent[] = [];
    const mgr = new AgentManager(
      () => {},
      (e) => {
        events.push(e);
      },
    );
    mgr.emitAgentActivity("agent-2", 2, "waiting", {
      activityId: "a2-1",
      kind: "worker",
      label: "todo ab12",
    });
    mgr.emitAgentActivity("agent-2", 2, "streaming", {
      activityId: "a2-1",
      label: "todo ab12",
    });
    const snap = mgr.getActivitySnapshot();
    assert.equal(snap["agent-2"]?.phase, "streaming");
    assert.equal(snap["agent-2"]?.label, "todo ab12");
    assert.equal(snap["agent-2"]?.kind, "worker");
    assert.ok(snap["agent-2"]?.startedAt);
    assert.equal(events.filter((e) => e.type === "agent_activity").length, 2);
  });

  it("emitAgentActivity still emits done when suppressStreamingFor is set", () => {
    const events: SwarmEvent[] = [];
    const mgr = new AgentManager(
      () => {},
      (e) => {
        events.push(e);
      },
    );
    (mgr as unknown as { suppressStreamingFor: Set<string> }).suppressStreamingFor.add("agent-3");
    mgr.emitAgentActivity("agent-3", 3, "waiting", { label: "warmup" });
    mgr.emitAgentActivity("agent-3", 3, "done", {});
    const acts = events.filter((e) => e.type === "agent_activity") as Array<{
      type: string;
      phase: string;
    }>;
    // waiting suppressed; done must pass through
    assert.equal(acts.length, 1);
    assert.equal(acts[0]!.phase, "done");
  });
});
