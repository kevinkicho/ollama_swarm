import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILD_ROLES, DEFAULT_ROLES, roleForAgent, selectRoleCatalog } from "./roles.js";

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

// 2026-05-02 (role-diff improvement #2): task-shaped catalog used when
// a directive is set. Same 7-slot shape as DEFAULT_ROLES so the modulo
// wrap behavior is unchanged for agent counts up to 8.
describe("BUILD_ROLES catalog (improvement #2)", () => {
  it("ships exactly 7 task-shaped roles", () => {
    assert.equal(BUILD_ROLES.length, 7);
    const names = BUILD_ROLES.map((r) => r.name);
    assert.deepEqual(names, [
      "Researcher",
      "Designer",
      "Implementer",
      "Tester",
      "Reviewer",
      "Documenter",
      "Devil's advocate",
    ]);
  });

  it("every role has guidance + a deliverableHint (improvement #3 contract)", () => {
    for (const role of BUILD_ROLES) {
      assert.ok(role.guidance.length > 20, `${role.name} guidance too short`);
      assert.ok(
        role.deliverableHint && role.deliverableHint.length > 20,
        `${role.name} missing/empty deliverableHint`,
      );
    }
  });
});

describe("selectRoleCatalog (improvement #2)", () => {
  it("returns BUILD_ROLES when a directive is set + no custom roles", () => {
    const out = selectRoleCatalog({ userDirective: "Refactor auth" });
    assert.equal(out, BUILD_ROLES);
  });

  it("returns DEFAULT_ROLES when no directive is set", () => {
    const out = selectRoleCatalog({});
    assert.equal(out, DEFAULT_ROLES);
  });

  it("treats whitespace-only directive as absent", () => {
    const out = selectRoleCatalog({ userDirective: "   \n\n   " });
    assert.equal(out, DEFAULT_ROLES);
  });

  it("custom roles always win over both default catalogs", () => {
    const custom = [{ name: "Custom", guidance: "custom role guidance text" }];
    assert.equal(
      selectRoleCatalog({ customRoles: custom, userDirective: "anything" }),
      custom,
    );
    assert.equal(selectRoleCatalog({ customRoles: custom }), custom);
  });

  it("ignores empty customRoles array — falls through to directive logic", () => {
    assert.equal(
      selectRoleCatalog({ customRoles: [], userDirective: "go" }),
      BUILD_ROLES,
    );
    assert.equal(selectRoleCatalog({ customRoles: [] }), DEFAULT_ROLES);
  });
});
