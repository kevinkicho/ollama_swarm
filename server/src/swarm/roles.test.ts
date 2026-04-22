import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ROLES, roleForAgent } from "./roles.js";

describe("DEFAULT_ROLES catalog", () => {
  it("covers the seven roles listed in docs/swarm-patterns.md", () => {
    assert.equal(DEFAULT_ROLES.length, 7);
    const names = DEFAULT_ROLES.map((r) => r.name);
    assert.deepEqual(names, [
      "Architect",
      "Tester",
      "Security reviewer",
      "Performance critic",
      "Docs reader",
      "Dependency auditor",
      "Devil's advocate",
    ]);
  });

  it("every role has non-empty name and guidance", () => {
    for (const role of DEFAULT_ROLES) {
      assert.ok(role.name.length > 0, `role.name empty for ${JSON.stringify(role)}`);
      assert.ok(role.guidance.length > 20, `role.guidance too short for ${role.name}`);
    }
  });
});

describe("roleForAgent", () => {
  it("returns the first role for agent 1 (indices are 1-based)", () => {
    const role = roleForAgent(1, DEFAULT_ROLES);
    assert.equal(role.name, "Architect");
  });

  it("returns sequential roles for agents 1..N", () => {
    for (let i = 1; i <= DEFAULT_ROLES.length; i++) {
      assert.equal(roleForAgent(i, DEFAULT_ROLES).name, DEFAULT_ROLES[i - 1].name);
    }
  });

  it("wraps with modulo when agentIndex exceeds roles.length", () => {
    // Seven roles; agent 8 should cycle back to agent 1's role.
    assert.equal(roleForAgent(8, DEFAULT_ROLES).name, DEFAULT_ROLES[0].name);
    assert.equal(roleForAgent(9, DEFAULT_ROLES).name, DEFAULT_ROLES[1].name);
    assert.equal(roleForAgent(14, DEFAULT_ROLES).name, DEFAULT_ROLES[6].name);
  });

  it("throws on invalid agentIndex", () => {
    assert.throws(() => roleForAgent(0, DEFAULT_ROLES), /integer >= 1/);
    assert.throws(() => roleForAgent(-1, DEFAULT_ROLES), /integer >= 1/);
    assert.throws(() => roleForAgent(1.5, DEFAULT_ROLES), /integer >= 1/);
  });

  it("throws on empty roles array", () => {
    assert.throws(() => roleForAgent(1, []), /roles array is empty/);
  });

  it("works with a custom 3-role table", () => {
    const custom = [
      { name: "A", guidance: "guidance-A placeholder text" },
      { name: "B", guidance: "guidance-B placeholder text" },
      { name: "C", guidance: "guidance-C placeholder text" },
    ];
    assert.equal(roleForAgent(1, custom).name, "A");
    assert.equal(roleForAgent(2, custom).name, "B");
    assert.equal(roleForAgent(3, custom).name, "C");
    assert.equal(roleForAgent(4, custom).name, "A");
  });
});
