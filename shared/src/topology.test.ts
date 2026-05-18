import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultRoleForIndex,
  isRoleStructural,
  synthesizeTopology,
  findAgentSpec,
  getAgentAddendum,
  getAgentTag,
  getAgentOllamaOptions,
  deriveLegacyFields,
  AgentSpecSchema,
  TopologySchema,
  type AgentRole,
} from "../src/topology.js";

describe("defaultRoleForIndex", () => {
  describe("blackboard preset", () => {
    it("index 1 is always planner", () => {
      assert.equal(defaultRoleForIndex("blackboard", 1, 5), "planner");
      assert.equal(defaultRoleForIndex("blackboard", 1, 3), "planner");
    });

    it("last agent is auditor", () => {
      assert.equal(defaultRoleForIndex("blackboard", 4, 4), "auditor");
      assert.equal(defaultRoleForIndex("blackboard", 3, 3), "auditor");
    });

    it("middle agents are workers", () => {
      assert.equal(defaultRoleForIndex("blackboard", 2, 5), "worker");
      assert.equal(defaultRoleForIndex("blackboard", 3, 5), "worker");
    });
  });

  describe("orchestrator-worker preset", () => {
    it("index 1 is orchestrator", () => {
      assert.equal(defaultRoleForIndex("orchestrator-worker", 1, 5), "orchestrator");
    });

    it("others are workers", () => {
      assert.equal(defaultRoleForIndex("orchestrator-worker", 2, 5), "worker");
      assert.equal(defaultRoleForIndex("orchestrator-worker", 5, 5), "worker");
    });
  });

  describe("debate-judge preset", () => {
    it("pro, con, judge at positions 1-3", () => {
      assert.equal(defaultRoleForIndex("debate-judge", 1, 3), "pro");
      assert.equal(defaultRoleForIndex("debate-judge", 2, 3), "con");
      assert.equal(defaultRoleForIndex("debate-judge", 3, 3), "judge");
    });

    it("beyond index 3 returns peer", () => {
      assert.equal(defaultRoleForIndex("debate-judge", 4, 5), "peer");
    });
  });

  describe("map-reduce preset", () => {
    it("index 1 is reducer", () => {
      assert.equal(defaultRoleForIndex("map-reduce", 1, 5), "reducer");
    });

    it("others are mappers", () => {
      assert.equal(defaultRoleForIndex("map-reduce", 2, 5), "mapper");
    });
  });

  describe("council preset", () => {
    it("all are drafters", () => {
      assert.equal(defaultRoleForIndex("council", 1, 5), "drafter");
      assert.equal(defaultRoleForIndex("council", 3, 5), "drafter");
    });
  });

  describe("stigmergy preset", () => {
    it("all are explorers", () => {
      assert.equal(defaultRoleForIndex("stigmergy", 1, 3), "explorer");
      assert.equal(defaultRoleForIndex("stigmergy", 2, 3), "explorer");
    });
  });

  describe("round-robin / role-diff presets", () => {
    it("round-robin: all are peers", () => {
      assert.equal(defaultRoleForIndex("round-robin", 1, 4), "peer");
      assert.equal(defaultRoleForIndex("round-robin", 3, 4), "peer");
    });

    it("role-diff: all are role-diff", () => {
      assert.equal(defaultRoleForIndex("role-diff", 1, 4), "role-diff");
    });
  });

  describe("pipeline preset", () => {
    it("index 1 is planner", () => {
      assert.equal(defaultRoleForIndex("pipeline", 1, 5), "planner");
    });

    it("others are peers", () => {
      assert.equal(defaultRoleForIndex("pipeline", 2, 5), "peer");
    });
  });

  describe("unknown preset falls back to planner/worker", () => {
    it("index 1 is planner", () => {
      assert.equal(defaultRoleForIndex("unknown-preset", 1, 5), "planner");
    });

    it("others are workers", () => {
      assert.equal(defaultRoleForIndex("unknown-preset", 2, 5), "worker");
    });
  });
});

describe("isRoleStructural", () => {
  it("all roles in debate-judge are structural", () => {
    assert.equal(isRoleStructural("debate-judge", "pro"), true);
    assert.equal(isRoleStructural("debate-judge", "con"), true);
    assert.equal(isRoleStructural("debate-judge", "judge"), true);
    assert.equal(isRoleStructural("debate-judge", "peer"), true);
  });

  it("planner, auditor, orchestrator are structural", () => {
    assert.equal(isRoleStructural("blackboard", "planner"), true);
    assert.equal(isRoleStructural("blackboard", "auditor"), true);
    assert.equal(isRoleStructural("orchestrator-worker", "orchestrator"), true);
  });

  it("mid-lead, reducer, pro, con are structural", () => {
    assert.equal(isRoleStructural("orchestrator-worker-deep", "mid-lead"), true);
    assert.equal(isRoleStructural("map-reduce", "reducer"), true);
  });

  it("workers, mappers, drafters, explorers, peers are NOT structural", () => {
    assert.equal(isRoleStructural("blackboard", "worker"), false);
    assert.equal(isRoleStructural("map-reduce", "mapper"), false);
    assert.equal(isRoleStructural("council", "drafter"), false);
    assert.equal(isRoleStructural("stigmergy", "explorer"), false);
    assert.equal(isRoleStructural("round-robin", "peer"), false);
  });
});

describe("synthesizeTopology", () => {
  it("generates correct agent count for blackboard without dedicated auditor", () => {
    const topo = synthesizeTopology("blackboard", 3);
    assert.equal(topo.agents.length, 3);
  });

  it("adds extra auditor for dedicatedAuditor on blackboard", () => {
    const topo = synthesizeTopology("blackboard", 3, { dedicatedAuditor: true });
    assert.equal(topo.agents.length, 4);
    assert.equal(topo.agents[3].role, "auditor");
  });

  it("dedicatedAuditor ignored for non-blackboard presets", () => {
    const topo = synthesizeTopology("council", 3, { dedicatedAuditor: true });
    assert.equal(topo.agents.length, 3);
  });

  it("assigns removable correctly", () => {
    const topo = synthesizeTopology("blackboard", 3);
    assert.equal(topo.agents[0].removable, false); // planner
    assert.equal(topo.agents[1].removable, true); // worker
    assert.equal(topo.agents[2].removable, false); // auditor
  });

  it("forwards role model overrides", () => {
    const topo = synthesizeTopology("blackboard", 3, {
      plannerModel: "planner-m",
      workerModel: "worker-m",
      auditorModel: "auditor-m",
    });
    assert.equal(topo.agents[0].model, "planner-m");
    assert.equal(topo.agents[1].model, "worker-m");
    assert.equal(topo.agents[2].model, "auditor-m");
  });

  it("uses plannerModel for orchestrator/reducer/judge roles", () => {
    const topo = synthesizeTopology("orchestrator-worker", 2, {
      plannerModel: "pm",
    });
    assert.equal(topo.agents[0].model, "pm"); // orchestrator
    assert.equal(topo.agents[1].model, undefined); // worker
  });
});

describe("findAgentSpec", () => {
  it("finds an agent by index", () => {
    const topo = synthesizeTopology("blackboard", 3);
    const spec = findAgentSpec(topo, 2);
    assert.equal(spec?.index, 2);
    assert.equal(spec?.role, "worker");
  });

  it("returns undefined for missing index", () => {
    const topo = synthesizeTopology("blackboard", 3);
    const spec = findAgentSpec(topo, 99);
    assert.equal(spec, undefined);
  });

  it("returns undefined when topology is undefined", () => {
    const spec = findAgentSpec(undefined, 1);
    assert.equal(spec, undefined);
  });
});

describe("getAgentAddendum", () => {
  it("returns promptAddendum when set", () => {
    const topo = synthesizeTopology("blackboard", 3);
    topo.agents[1].promptAddendum = "Focus on tests.";
    assert.equal(getAgentAddendum(topo, 2), "Focus on tests.");
  });

  it("returns undefined when addendum is whitespace-only", () => {
    const topo = synthesizeTopology("blackboard", 3);
    topo.agents[1].promptAddendum = "   ";
    assert.equal(getAgentAddendum(topo, 2), undefined);
  });

  it("returns undefined when topology is undefined", () => {
    assert.equal(getAgentAddendum(undefined, 1), undefined);
  });
});

describe("getAgentTag", () => {
  it("returns tag when set", () => {
    const topo = synthesizeTopology("blackboard", 3);
    topo.agents[1].tag = "test-expert";
    assert.equal(getAgentTag(topo, 2), "test-expert");
  });

  it("returns undefined when tag is whitespace-only", () => {
    const topo = synthesizeTopology("blackboard", 3);
    topo.agents[1].tag = "  ";
    assert.equal(getAgentTag(topo, 2), undefined);
  });

  it("returns undefined when not set", () => {
    const topo = synthesizeTopology("blackboard", 3);
    assert.equal(getAgentTag(topo, 2), undefined);
  });

  it("returns undefined when topology is undefined", () => {
    assert.equal(getAgentTag(undefined, 1), undefined);
  });
});

describe("getAgentOllamaOptions", () => {
  it("returns temperature when set", () => {
    const topo = synthesizeTopology("blackboard", 3);
    topo.agents[1].temperature = 0.7;
    assert.deepEqual(getAgentOllamaOptions(topo, 2), { temperature: 0.7 });
  });

  it("returns undefined when no options are set", () => {
    const topo = synthesizeTopology("blackboard", 3);
    assert.equal(getAgentOllamaOptions(topo, 2), undefined);
  });

  it("returns undefined when topology is undefined", () => {
    assert.equal(getAgentOllamaOptions(undefined, 1), undefined);
  });

  it("handles temperature of 0 (falsy but valid)", () => {
    const topo = synthesizeTopology("blackboard", 3);
    topo.agents[1].temperature = 0;
    assert.deepEqual(getAgentOllamaOptions(topo, 2), { temperature: 0 });
  });
});

describe("deriveLegacyFields", () => {
  it("derives agentCount excluding auditor for blackboard with dedicated auditor", () => {
    const topo = synthesizeTopology("blackboard", 3, { dedicatedAuditor: true });
    const legacy = deriveLegacyFields(topo, "blackboard");
    assert.equal(legacy.agentCount, 3);
    assert.equal(legacy.dedicatedAuditor, true);
  });

  it("handles blackboard without dedicated auditor (no auditor role in topology)", () => {
    // Blackboard topology where last agent IS auditor — this triggers dedicatedAuditor=true
    // because deriveLegacyFields detects the auditor role from topology agents.
    const topo = synthesizeTopology("blackboard", 3);
    const legacy = deriveLegacyFields(topo, "blackboard");
    assert.equal(legacy.agentCount, 2); // 3 agents - 1 auditor = 2
    assert.equal(legacy.dedicatedAuditor, true);
  });

  it("handles blackboard without auditor in topology", () => {
    // Non-blackboard presets don't get dedicated auditor treatment
    const topo = synthesizeTopology("council", 3);
    const legacy = deriveLegacyFields(topo, "council");
    assert.equal(legacy.agentCount, 3);
    assert.equal(legacy.dedicatedAuditor, false);
  });

  it("non-blackboard presets derive agentCount = total agents", () => {
    const topo = synthesizeTopology("council", 5);
    const legacy = deriveLegacyFields(topo, "council");
    assert.equal(legacy.agentCount, 5);
    assert.equal(legacy.dedicatedAuditor, false);
  });

  it("extracts per-role model overrides", () => {
    const topo = synthesizeTopology("blackboard", 3, {
      plannerModel: "pm",
      workerModel: "wm",
    });
    const legacy = deriveLegacyFields(topo, "blackboard");
    assert.equal(legacy.plannerModel, "pm");
    assert.equal(legacy.workerModel, "wm");
  });
});

describe("AgentSpecSchema", () => {
  it("validates a minimal spec", () => {
    const result = AgentSpecSchema.safeParse({
      index: 1,
      role: "worker",
      removable: true,
    });
    assert.equal(result.success, true);
  });

  it("rejects index out of range", () => {
    assert.equal(AgentSpecSchema.safeParse({ index: 0, role: "worker", removable: true }).success, false);
    assert.equal(AgentSpecSchema.safeParse({ index: 17, role: "worker", removable: true }).success, false);
  });

  it("rejects unknown role", () => {
    assert.equal(
      AgentSpecSchema.safeParse({ index: 1, role: "unknown", removable: true }).success,
      false,
    );
  });

  it("accepts optional fields", () => {
    const result = AgentSpecSchema.safeParse({
      index: 1,
      role: "planner",
      removable: false,
      model: "gemma:31b",
      tag: "security",
      color: "emerald",
      temperature: 0.8,
      promptAddendum: "Be careful.",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.model, "gemma:31b");
      assert.equal(result.data.temperature, 0.8);
    }
  });

  it("validates temperature range", () => {
    assert.equal(
      AgentSpecSchema.safeParse({ index: 1, role: "worker", removable: true, temperature: 2.5 }).success,
      false,
    );
    assert.equal(
      AgentSpecSchema.safeParse({ index: 1, role: "worker", removable: true, temperature: -0.1 }).success,
      false,
    );
  });

  it("rejects tag exceeding 40 chars", () => {
    assert.equal(
      AgentSpecSchema.safeParse({ index: 1, role: "worker", removable: true, tag: "a".repeat(41) }).success,
      false,
    );
  });
});

describe("TopologySchema", () => {
  it("validates a valid topology", () => {
    const result = TopologySchema.safeParse(synthesizeTopology("blackboard", 3));
    assert.equal(result.success, true);
  });

  it("rejects topology with zero agents", () => {
    const result = TopologySchema.safeParse({ agents: [] });
    assert.equal(result.success, false);
  });

  it("rejects topology with >16 agents", () => {
    const agents = Array.from({ length: 17 }, (_, i) => ({
      index: i + 1,
      role: "worker" as AgentRole,
      removable: true,
    }));
    const result = TopologySchema.safeParse({ agents });
    assert.equal(result.success, false);
  });
});
