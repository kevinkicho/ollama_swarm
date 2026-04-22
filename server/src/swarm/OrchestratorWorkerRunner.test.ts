import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePlan,
  buildLeadPlanPrompt,
  buildWorkerPrompt,
  buildLeadSynthesisPrompt,
} from "./OrchestratorWorkerRunner.js";
import type { TranscriptEntry } from "../types.js";

const system = (text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "system",
  text,
  ts: 0,
});

const agent = (index: number, text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "agent",
  agentIndex: index,
  agentId: `agent-${index}`,
  text,
  ts: 0,
});

describe("parsePlan — happy path", () => {
  it("parses a clean JSON object with assignments", () => {
    const raw = '{"assignments":[{"agentIndex":2,"subtask":"inspect src/"},{"agentIndex":3,"subtask":"read README"}]}';
    const plan = parsePlan(raw, [2, 3, 4]);
    assert.equal(plan.assignments.length, 2);
    assert.deepEqual(plan.assignments[0], { agentIndex: 2, subtask: "inspect src/" });
    assert.deepEqual(plan.assignments[1], { agentIndex: 3, subtask: "read README" });
  });

  it("strips a markdown fence before parsing", () => {
    const raw =
      "```json\n" +
      '{"assignments":[{"agentIndex":2,"subtask":"inspect src/"}]}' +
      "\n```";
    const plan = parsePlan(raw, [2, 3]);
    assert.equal(plan.assignments.length, 1);
  });

  it("finds the first JSON object when surrounded by prose", () => {
    const raw = 'Sure, here is my plan:\n{"assignments":[{"agentIndex":2,"subtask":"X"}]}\nLet me know!';
    const plan = parsePlan(raw, [2]);
    assert.equal(plan.assignments.length, 1);
    assert.equal(plan.assignments[0].subtask, "X");
  });
});

describe("parsePlan — guards", () => {
  it("drops assignments whose agentIndex isn't in the worker set", () => {
    // Agent 1 is the lead and must never get assigned work.
    const raw = '{"assignments":[{"agentIndex":1,"subtask":"self"},{"agentIndex":2,"subtask":"ok"}]}';
    const plan = parsePlan(raw, [2, 3]);
    assert.equal(plan.assignments.length, 1);
    assert.equal(plan.assignments[0].agentIndex, 2);
  });

  it("drops duplicate agentIndex (keeps the first)", () => {
    const raw = '{"assignments":[{"agentIndex":2,"subtask":"first"},{"agentIndex":2,"subtask":"second"}]}';
    const plan = parsePlan(raw, [2, 3]);
    assert.equal(plan.assignments.length, 1);
    assert.equal(plan.assignments[0].subtask, "first");
  });

  it("drops assignments with missing or empty subtask", () => {
    const raw = '{"assignments":[{"agentIndex":2,"subtask":""},{"agentIndex":3,"subtask":"ok"}]}';
    const plan = parsePlan(raw, [2, 3]);
    assert.equal(plan.assignments.length, 1);
    assert.equal(plan.assignments[0].agentIndex, 3);
  });

  it("returns empty plan on totally unparseable input", () => {
    const plan = parsePlan("this is not JSON at all", [2, 3]);
    assert.equal(plan.assignments.length, 0);
  });

  it("returns empty plan when assignments is not an array", () => {
    const raw = '{"assignments":"not-an-array"}';
    const plan = parsePlan(raw, [2, 3]);
    assert.equal(plan.assignments.length, 0);
  });
});

describe("buildLeadPlanPrompt", () => {
  it("names all worker agents and forbids assigning work to the lead", () => {
    const prompt = buildLeadPlanPrompt(1, 3, [2, 3, 4], []);
    assert.ok(prompt.includes("Agent 2"));
    assert.ok(prompt.includes("Agent 3"));
    assert.ok(prompt.includes("Agent 4"));
    // Lead's role — "no assignment to self" is implicit in the worker list;
    // we just check agent 1 isn't listed as an available worker.
    assert.ok(!/Your workers are:[^\n]*Agent 1/.test(prompt));
  });

  it("requires JSON-only output shape", () => {
    const prompt = buildLeadPlanPrompt(1, 3, [2, 3], []);
    assert.match(prompt, /Output ONLY a JSON object/);
    assert.match(prompt, /"assignments"/);
    assert.match(prompt, /"agentIndex"/);
    assert.match(prompt, /"subtask"/);
  });

  it("cycle 1 gets a broad-coverage hint", () => {
    const prompt = buildLeadPlanPrompt(1, 3, [2, 3], []);
    assert.match(prompt, /cycle 1.*broad coverage/i);
  });

  it("cycle >1 tells the lead to refine based on prior syntheses", () => {
    const prompt = buildLeadPlanPrompt(2, 3, [2, 3], [system("seed")]);
    assert.match(prompt, /later cycle.*prior cycle syntheses/i);
  });
});

describe("buildWorkerPrompt — independence", () => {
  it("includes only the assigned subtask and seed, NOT the full transcript", () => {
    const seed: TranscriptEntry[] = [system("cloned to /tmp/x")];
    const prompt = buildWorkerPrompt(2, 1, 3, "inspect tests/", seed);
    assert.ok(prompt.includes("inspect tests/"));
    assert.ok(prompt.includes("[SYSTEM] cloned to /tmp/x"));
    // Must NOT carry peer content or the lead's plan text
    assert.ok(!prompt.includes("assignments"));
    assert.ok(!prompt.includes("Agent 3"));
  });

  it("tells the worker it cannot see peers — by design", () => {
    const prompt = buildWorkerPrompt(2, 1, 3, "X", [system("seed")]);
    assert.match(prompt, /cannot see.*deliberate/i);
  });

  it("identifies the worker by index in header + closing", () => {
    const prompt = buildWorkerPrompt(5, 1, 3, "X", []);
    assert.ok(prompt.includes("Worker Agent 5"));
    assert.ok(prompt.includes("Now respond as Worker Agent 5."));
  });
});

describe("buildLeadSynthesisPrompt", () => {
  it("includes worker reports in the transcript body", () => {
    const t: TranscriptEntry[] = [
      system("seed"),
      agent(2, "worker 2 report — UNIQUE_REPORT_ABC"),
      agent(3, "worker 3 report — UNIQUE_REPORT_DEF"),
    ];
    const prompt = buildLeadSynthesisPrompt(1, 3, t);
    assert.ok(prompt.includes("UNIQUE_REPORT_ABC"));
    assert.ok(prompt.includes("UNIQUE_REPORT_DEF"));
  });

  it("asks for a concrete next action citing worker findings", () => {
    const prompt = buildLeadSynthesisPrompt(1, 3, []);
    assert.match(prompt, /concrete next action/i);
    assert.match(prompt, /citing worker findings/i);
  });

  it("last cycle gets a final-recommendation close", () => {
    const prompt = buildLeadSynthesisPrompt(3, 3, []);
    assert.match(prompt, /final recommendation/i);
  });

  it("mid-run cycle asks for a gap to investigate next", () => {
    const prompt = buildLeadSynthesisPrompt(1, 3, []);
    assert.match(prompt, /gap or inconsistency/i);
  });
});
