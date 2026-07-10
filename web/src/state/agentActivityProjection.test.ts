import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStreamingDockSlots,
  resolveAgentIndex,
} from "./agentActivityProjection.js";

test("buildStreamingDockSlots — placeholder for thinking agent without tokens", () => {
  const startedAt = Date.now() - 500;
  const slots = buildStreamingDockSlots(
    {
      "agent-3": {
        id: "agent-3",
        index: 3,
        status: "thinking",
        thinkingSince: startedAt,
        activityLabel: "council turn",
        model: "deepseek-v4-flash:cloud",
      },
    },
    {},
    {},
    {
      "agent-3": {
        phase: "queued",
        ts: startedAt + 100,
        startedAt,
        label: "council turn",
      },
    },
  );
  assert.equal(slots.length, 1);
  assert.equal(slots[0].agentId, "agent-3");
  assert.equal(slots[0].waiting, true);
  assert.equal(slots[0].waitingLabel, "council turn");
});

test("buildStreamingDockSlots — labeled busy agent switches to receiving after grace", () => {
  const startedAt = Date.now() - 5_000;
  const slots = buildStreamingDockSlots(
    {
      "agent-1": {
        id: "agent-1",
        index: 1,
        status: "thinking",
        thinkingSince: startedAt,
        activityLabel: "goal analysis",
      },
    },
    {},
    {},
    {
      "agent-1": {
        phase: "waiting",
        ts: startedAt + 100,
        startedAt,
        label: "goal analysis",
      },
    },
  );
  assert.equal(slots.length, 1);
  assert.equal(slots[0].waiting, false);
  assert.equal(slots[0].receiving, true);
});

test("buildStreamingDockSlots — streaming agent not marked waiting when text arrives", () => {
  const slots = buildStreamingDockSlots(
    {
      "agent-4": { id: "agent-4", index: 4, status: "thinking", thinkingSince: 500 },
    },
    { "agent-4": "Hello" },
    {
      "agent-4": { startedAt: 500, lastTextAt: 600, status: "live" },
    },
    {
      "agent-4": { phase: "streaming", ts: 600, startedAt: 500 },
    },
  );
  assert.equal(slots.length, 1);
  assert.equal(slots[0].waiting, false);
  assert.equal(slots[0].text, "Hello");
});

test("buildStreamingDockSlots — streaming phase is receiving not awaiting", () => {
  const slots = buildStreamingDockSlots(
    {
      "agent-1": {
        id: "agent-1",
        index: 1,
        status: "thinking",
        thinkingSince: 1_000,
        activityLabel: "contract merge",
      },
    },
    {},
    {},
    {
      "agent-1": {
        phase: "streaming",
        ts: 52_000,
        startedAt: 1_000,
        label: "contract merge",
      },
    },
  );
  assert.equal(slots.length, 1);
  assert.equal(slots[0].waiting, false);
  assert.equal(slots[0].receiving, true);
});

test("buildStreamingDockSlots — demotes sticky thinking when activity is done", () => {
  const slots = buildStreamingDockSlots(
    {
      "agent-2": {
        id: "agent-2",
        index: 2,
        status: "thinking",
        thinkingSince: 100,
      },
    },
    {},
    {},
    {
      "agent-2": {
        phase: "done",
        ts: 9_000,
        startedAt: 100,
        label: "synthesis",
      },
    },
  );
  assert.equal(slots.length, 0);
});

test("buildStreamingDockSlots — stale waiting activity does not resurrect dock", () => {
  const slots = buildStreamingDockSlots(
    {
      "agent-1": {
        id: "agent-1",
        index: 1,
        status: "ready",
      },
    },
    {},
    {},
    {
      "agent-1": {
        phase: "waiting",
        ts: 2_000,
        startedAt: 1_000,
        label: "contract draft",
      },
    },
  );
  assert.equal(slots.length, 0);
});

test("resolveAgentIndex — parses agent-N when roster row is missing", () => {
  assert.equal(resolveAgentIndex("agent-1"), 1);
  assert.equal(resolveAgentIndex("agent-6"), 6);
  assert.equal(resolveAgentIndex("brain"), 0);
});

test("buildStreamingDockSlots — uses agent id when roster index missing", () => {
  const slots = buildStreamingDockSlots(
    {},
    { "agent-1": "partial" },
    {
      "agent-1": { startedAt: 100, lastTextAt: 200, status: "live" },
    },
    {},
  );
  assert.equal(slots.length, 1);
  assert.equal(slots[0].agentIndex, 1);
});

test("buildStreamingDockSlots — sorts by agent index", () => {
  const slots = buildStreamingDockSlots(
    {
      "agent-4": { id: "agent-4", index: 4, status: "thinking", thinkingSince: 1 },
      "agent-3": { id: "agent-3", index: 3, status: "thinking", thinkingSince: 1 },
    },
    {},
    {},
    {},
  );
  assert.deepEqual(slots.map((s) => s.agentIndex), [3, 4]);
});