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

// 2026-05-02 (OW directive lever): directive-aware paths.

describe("buildLeadPlanPrompt — directive injection", () => {
  it("injects USER DIRECTIVE block + decompose framing when directive set", () => {
    const prompt = buildLeadPlanPrompt(1, 3, [2, 3], [], "Refactor auth to bcrypt.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Refactor auth to bcrypt\./);
    assert.match(prompt, /DECOMPOSE the directive into worker subtasks/);
  });

  it("swaps subtask example copy for directive-relevant decomposition examples", () => {
    const prompt = buildLeadPlanPrompt(1, 3, [2, 3], [], "x");
    assert.match(prompt, /Subtasks DECOMPOSE THE DIRECTIVE/);
    // The generic 'inspect src/foo/' example should NOT appear in the directive path
    assert.ok(!/"inspect src\/foo\/", "read README and package\.json"/.test(prompt));
  });

  it("falls back to original generic copy when directive absent", () => {
    const prompt = buildLeadPlanPrompt(1, 3, [2, 3], []);
    assert.ok(!/USER DIRECTIVE/.test(prompt));
    assert.match(prompt, /Subtasks should DIVIDE LABOR/);
  });

  it("treats whitespace-only directive as absent", () => {
    const prompt = buildLeadPlanPrompt(1, 3, [2, 3], [], "   \n\n   ");
    assert.ok(!/USER DIRECTIVE/.test(prompt));
  });
});

describe("buildWorkerPrompt — directive injection", () => {
  it("injects directive context + 'no relevant findings' valve when directive set", () => {
    const prompt = buildWorkerPrompt(2, 1, 3, "subtask", [], "Find bcrypt uses.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Find bcrypt uses\./);
    assert.match(prompt, /NO RELEVANT FINDINGS.*VALID ANSWER/);
    assert.match(prompt, /Do NOT invent relevance/);
  });

  it("falls back to original copy when directive absent", () => {
    const prompt = buildWorkerPrompt(2, 1, 3, "subtask", []);
    assert.ok(!/USER DIRECTIVE/.test(prompt));
    assert.ok(!/NO RELEVANT FINDINGS/.test(prompt));
  });

  it("preserves the 'cannot see peers' invariant in both paths", () => {
    for (const p of [
      buildWorkerPrompt(2, 1, 3, "x", []),
      buildWorkerPrompt(2, 1, 3, "x", [], "directive"),
    ]) {
      assert.match(p, /cannot see.*deliberate/i);
    }
  });
});

describe("buildLeadSynthesisPrompt — directive injection", () => {
  it("when directive set, leads with USER DIRECTIVE block + Answer-to-directive section", () => {
    const prompt = buildLeadSynthesisPrompt(1, 3, [], "Refactor auth.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Refactor auth\./);
    assert.match(prompt, /\*\*Answer to directive\*\*/);
  });

  it("mid-cycle directive path asks for a coverage gap toward the directive", () => {
    const prompt = buildLeadSynthesisPrompt(1, 3, [], "x");
    assert.match(prompt, /Coverage gap toward the directive/);
  });

  it("final-cycle directive path asks for the final recommendation toward the directive", () => {
    const prompt = buildLeadSynthesisPrompt(3, 3, [], "x");
    assert.match(prompt, /\*\*Final recommendation\*\*/);
    assert.match(prompt, /toward the directive/);
  });

  it("falls back to original framing when directive absent", () => {
    const prompt = buildLeadSynthesisPrompt(1, 3, []);
    assert.ok(!/USER DIRECTIVE/.test(prompt));
    assert.ok(!/\*\*Answer to directive\*\*/.test(prompt));
    assert.match(prompt, /concrete next action/i);
  });
});

// Structural runner wiring + form spec.

import { readFileSync as _read } from "node:fs";
import { join as _join, dirname as _dirname } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";

const _here = _dirname(_fileURLToPath(import.meta.url));
const OW_SRC = _read(_join(_here, "OrchestratorWorkerRunner.ts"), "utf8");

describe("OrchestratorWorkerRunner — directive plumbing (structural, post Phase A)", () => {
  it("seed uses readDirective + buildDirectiveBlock helpers", () => {
    assert.match(OW_SRC, /readDirective\(cfg\)/);
    assert.match(OW_SRC, /buildDirectiveBlock\(/);
  });

  it("loop threads cfg.userDirective into buildLeadPlanPrompt + runWorkerTurn + buildLeadSynthesisPrompt", () => {
    assert.match(
      OW_SRC,
      /buildLeadPlanPrompt\(r, cfg\.rounds, workers\.map\(\(w\) => w\.index\), \[\.\.\.this\.transcript\], cfg\.userDirective\)/,
    );
    assert.match(
      OW_SRC,
      /this\.runWorkerTurn\(\s*w,\s*r,\s*cfg\.rounds,\s*a\.subtask,\s*seedSnapshot,\s*cfg\.userDirective,\s*a\.successCriteria,?\s*\)/,
    );
    assert.match(
      OW_SRC,
      /buildLeadSynthesisPrompt\(r, cfg\.rounds, \[\.\.\.this\.transcript\], cfg\.userDirective\)/,
    );
  });

  it("runWorkerTurn threads userDirective + successCriteria into buildWorkerPrompt", () => {
    // T175 (2026-05-04): buildWorkerPrompt now takes a 7th arg
    // (successCriteria) that the lead's plan can populate. The
    // wire-through must also pass it from runWorkerTurn's signature.
    assert.match(
      OW_SRC,
      /buildWorkerPrompt\(\s*agent\.index,\s*round,\s*totalRounds,\s*subtask,\s*visibleSeed,\s*userDirective,\s*successCriteria,?\s*\)/,
    );
  });

  it("(T175) Plan.assignments support optional successCriteria field", () => {
    // The lead's plan JSON can include successCriteria per assignment;
    // parsePlan extracts it; the runner threads it to buildWorkerPrompt.
    assert.match(
      OW_SRC,
      /successCriteria\?:\s*string/,
      "Assignment interface must declare optional successCriteria",
    );
    assert.match(
      OW_SRC,
      /successCriteria\s*\}\s*:\s*\{\s*\}/,
      "parsePlan must conditionally include successCriteria in assignments",
    );
  });

  it("(T175) buildLeadPlanPrompt instructs the lead to emit successCriteria", () => {
    assert.match(
      OW_SRC,
      /successCriteria/,
      "lead's plan prompt must reference successCriteria",
    );
    assert.match(
      OW_SRC,
      /SUCCESS CRITERIA/,
      "worker prompt must surface the success criteria block",
    );
    assert.match(
      OW_SRC,
      /SELF-EVAL: PASS/,
      "worker prompt must require a self-eval line under the rubric",
    );
  });

  it("deliverable uses pickDeliverableTitle + maybeDirectiveSection helpers", () => {
    assert.match(
      OW_SRC,
      /pickDeliverableTitle\(dirCtx,\s*\{[\s\S]{0,200}?withDirective:\s*"Orchestrator–worker: directive answer"/,
      "deliverable title must use pickDeliverableTitle helper",
    );
    assert.match(
      OW_SRC,
      /pickAnswerSectionTitle\(dirCtx,\s*\{[\s\S]{0,200}?withDirective:\s*"Answer to directive"/,
      "synthesis section title must use pickAnswerSectionTitle helper",
    );
    assert.match(OW_SRC, /maybeDirectiveSection\(dirCtx\)/);
  });
});

describe("OW form spec", () => {
  it("orchestrator-worker is now directive: 'honored'", () => {
    const setup = _read(
      _join(_here, "../../../web/src/components/SetupForm.tsx"),
      "utf8",
    );
    const block = setup.match(/id:\s*"orchestrator-worker"[\s\S]{0,1500}?\},/);
    assert.ok(block, "orchestrator-worker preset block must exist");
    assert.match(block![0], /directive:\s*"honored"/);
  });
});
