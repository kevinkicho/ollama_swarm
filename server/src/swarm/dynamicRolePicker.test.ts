// Q6 (2026-05-04): tests for dynamic role picker.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDynamicRolePickerPrompt,
  parseDynamicRolePick,
} from "./dynamicRolePicker.js";

const ROLES = [
  { id: "critic", label: "Critic", description: "challenge claims" },
  { id: "synthesizer", label: "Synth", description: "merge perspectives" },
  { id: "builder", label: "Builder", description: "produce concrete output" },
  { id: "gap-finder", label: "Gap-finder", description: "find what's missing" },
];

test("buildDynamicRolePickerPrompt — includes roles + recent turns + JSON shape", () => {
  const prompt = buildDynamicRolePickerPrompt({
    roles: ROLES,
    recentTurns: [
      { role: "agent", text: "I built X", agentIndex: 1 },
      { role: "agent", text: "I built Y similar to X", agentIndex: 2 },
    ],
    recentlyUsedRoleIds: ["builder"],
  });
  assert.match(prompt, /critic/);
  assert.match(prompt, /synthesizer/);
  assert.match(prompt, /Recently used \(try to vary\): builder/);
  assert.match(prompt, /I built X/);
  assert.match(prompt, /I built Y similar/);
  assert.match(prompt, /STRICT JSON/);
});

test("buildDynamicRolePickerPrompt — folds in user directive", () => {
  const prompt = buildDynamicRolePickerPrompt({
    roles: ROLES,
    recentTurns: [],
    recentlyUsedRoleIds: [],
    userDirective: "Improve API throughput",
  });
  assert.match(prompt, /Directive: Improve API throughput/);
});

test("buildDynamicRolePickerPrompt — omits 'recently used' note when empty", () => {
  const prompt = buildDynamicRolePickerPrompt({
    roles: ROLES,
    recentTurns: [],
    recentlyUsedRoleIds: [],
  });
  assert.equal(prompt.includes("Recently used"), false);
});

test("buildDynamicRolePickerPrompt — truncates long turn text", () => {
  const longText = "x".repeat(2000);
  const prompt = buildDynamicRolePickerPrompt({
    roles: ROLES,
    recentTurns: [{ role: "agent", text: longText }],
    recentlyUsedRoleIds: [],
  });
  // Should be capped at ~600 chars per turn text
  const xCount = (prompt.match(/x/g) || []).length;
  assert.ok(xCount <= 700, `expected ~600 x's, got ${xCount}`);
});

test("parseDynamicRolePick — strict JSON happy path", () => {
  const got = parseDynamicRolePick(
    '{"pickedId": "critic", "rationale": "convergence detected"}',
    ROLES.map((r) => r.id),
  );
  assert.equal(got?.pickedId, "critic");
  assert.match(got!.rationale, /convergence/);
});

test("parseDynamicRolePick — fenced JSON tolerated", () => {
  const got = parseDynamicRolePick(
    '```json\n{"pickedId": "synthesizer"}\n```',
    ROLES.map((r) => r.id),
  );
  assert.equal(got?.pickedId, "synthesizer");
});

test("parseDynamicRolePick — invalid id rejected (not in catalog)", () => {
  assert.equal(
    parseDynamicRolePick(
      '{"pickedId": "ghost-role"}',
      ROLES.map((r) => r.id),
    ),
    null,
  );
});

test("parseDynamicRolePick — missing pickedId → null", () => {
  assert.equal(
    parseDynamicRolePick(
      '{"rationale": "x"}',
      ROLES.map((r) => r.id),
    ),
    null,
  );
});

test("parseDynamicRolePick — empty rationale tolerated", () => {
  const got = parseDynamicRolePick(
    '{"pickedId": "builder"}',
    ROLES.map((r) => r.id),
  );
  assert.equal(got?.pickedId, "builder");
  assert.equal(got?.rationale, "");
});

test("parseDynamicRolePick — JSON embedded in surrounding prose", () => {
  const got = parseDynamicRolePick(
    'Here is my pick:\n{"pickedId": "gap-finder"}\nDone.',
    ROLES.map((r) => r.id),
  );
  assert.equal(got?.pickedId, "gap-finder");
});
