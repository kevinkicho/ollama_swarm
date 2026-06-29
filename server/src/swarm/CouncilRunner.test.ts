import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCouncilPrompt,
  buildCouncilSynthesisPrompt,
} from "./CouncilRunner.js";
import type { TranscriptEntry } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COUNCIL_SRC = readFileSync(join(__dirname, "CouncilRunner.ts"), "utf8");
const DELIVERABLE_SRC = readFileSync(join(__dirname, "councilDeliverable.ts"), "utf8");
const SYNTHESIS_SRC = readFileSync(join(__dirname, "councilSynthesis.ts"), "utf8");
const ALL_COUNCIL_SRC = COUNCIL_SRC + "\n" + DELIVERABLE_SRC + "\n" + SYNTHESIS_SRC;

const system = (text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "system",
  text,
  ts: 0,
});

const user = (text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "user",
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

describe("buildCouncilPrompt — round 1 independence", () => {
  it("omits peer-agent entries from the transcript body in round 1", () => {
    const snapshot: TranscriptEntry[] = [
      system("Cloned repo-x to /tmp/clone"),
      agent(2, "FORBIDDEN_CONTENT_ALPHA xyz123"),
      agent(3, "FORBIDDEN_CONTENT_BETA qwe456"),
    ];
    const prompt = buildCouncilPrompt(1, 1, 3, snapshot);
    assert.ok(
      !prompt.includes("FORBIDDEN_CONTENT_ALPHA"),
      "round 1 prompt must not include peer agent 2's draft body",
    );
    assert.ok(
      !prompt.includes("FORBIDDEN_CONTENT_BETA"),
      "round 1 prompt must not include peer agent 3's draft body",
    );
    assert.ok(!prompt.includes("[Agent 2]"), "round 1 must not show a [Agent 2] transcript line");
    assert.ok(!prompt.includes("[Agent 3]"), "round 1 must not show a [Agent 3] transcript line");
    assert.ok(prompt.includes("Cloned repo-x to /tmp/clone"), "round 1 must still include system seed");
  });

  it("keeps system and user entries visible in round 1", () => {
    const snapshot: TranscriptEntry[] = [
      system("seed message"),
      user("human question"),
      agent(5, "FORBIDDEN_PEER_CONTENT"),
    ];
    const prompt = buildCouncilPrompt(1, 1, 3, snapshot);
    assert.ok(prompt.includes("[SYSTEM] seed message"));
    assert.ok(prompt.includes("[HUMAN] human question"));
    assert.ok(!prompt.includes("FORBIDDEN_PEER_CONTENT"));
  });

  it("announces the round is a code audit in round 1", () => {
    const prompt = buildCouncilPrompt(1, 1, 3, [system("seed")]);
    assert.match(prompt, /auditing the codebase/i);
    assert.match(prompt, /PROJECT CONTEXT/i);
  });

  it("handles an empty transcript gracefully in round 1", () => {
    const prompt = buildCouncilPrompt(1, 1, 3, []);
    assert.ok(prompt.includes("(empty — you are writing the first entry)"));
  });
});

describe("buildCouncilPrompt — round 2+ reveal", () => {
  it("includes peer-agent entries in the transcript body in round 2", () => {
    const snapshot: TranscriptEntry[] = [
      system("seed"),
      agent(1, "round-1 draft by agent 1"),
      agent(2, "round-1 draft by agent 2"),
      agent(3, "round-1 draft by agent 3"),
    ];
    const prompt = buildCouncilPrompt(1, 2, 3, snapshot);
    assert.ok(prompt.includes("round-1 draft by agent 1"));
    assert.ok(prompt.includes("round-1 draft by agent 2"));
    assert.ok(prompt.includes("round-1 draft by agent 3"));
  });

  it("announces the round is a follow-up audit in round 2+", () => {
    const prompt = buildCouncilPrompt(1, 2, 3, [system("seed")]);
    assert.match(prompt, /round 2 of 3/i);
    assert.match(prompt, /other agents' findings/i);
  });

  it("still includes peers in round 3", () => {
    const snapshot: TranscriptEntry[] = [
      system("seed"),
      agent(2, "something important"),
    ];
    const prompt = buildCouncilPrompt(1, 3, 3, snapshot);
    assert.ok(prompt.includes("something important"));
    assert.match(prompt, /round 3 of 3/i);
  });
});

describe("buildCouncilPrompt — general shape", () => {
  it("identifies the requesting agent in both the header and the closing line", () => {
    const prompt = buildCouncilPrompt(4, 1, 3, []);
    assert.ok(prompt.includes("You are Agent 4"));
    assert.ok(prompt.includes("Now respond as Agent 4."));
  });

  it("states the audit goals (no directive)", () => {
    const prompt = buildCouncilPrompt(1, 1, 3, []);
    assert.match(prompt, /auditing the codebase/i);
    assert.match(prompt, /READ the actual code/i);
    assert.match(prompt, /identify what's broken/i);
  });
});

describe("buildCouncilPrompt — directive injection", () => {
  it("injects USER DIRECTIVE block when a directive is set", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "Refactor auth to use bcrypt.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Refactor auth to use bcrypt\./);
  });

  it("includes directive-driven instructions when set", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "Refactor auth.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Refactor auth/);
    assert.ok(!/Figure out what this project is/.test(prompt));
  });

  it("treats whitespace-only directive as absent", () => {
    const prompt = buildCouncilPrompt(2, 1, 3, [], "   \n\n   ");
    assert.ok(!/USER DIRECTIVE/.test(prompt));
    assert.match(prompt, /auditing the codebase/i);
  });
});

describe("buildCouncilSynthesisPrompt", () => {
  it("produces an action plan structure", () => {
    const prompt = buildCouncilSynthesisPrompt(2, []);
    assert.match(prompt, /merged action plan/i);
    assert.match(prompt, /AGENT FINDINGS/i);
  });

  it("when directive set, includes USER DIRECTIVE block", () => {
    const prompt = buildCouncilSynthesisPrompt(2, [], "Refactor auth.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Refactor auth\./);
  });

  it("includes committed files block when provided", () => {
    const prompt = buildCouncilSynthesisPrompt(2, [], undefined, ["src/foo.ts", "src/bar.ts"]);
    assert.match(prompt, /ALREADY COMMITTED/);
    assert.match(prompt, /src\/foo\.ts/);
    assert.match(prompt, /src\/bar\.ts/);
  });

  it("includes ambition tier guidance when tier > 1", () => {
    const prompt = buildCouncilSynthesisPrompt(2, [], undefined, undefined, 3);
    assert.match(prompt, /ambition tier 3/);
    assert.match(prompt, /MATERIALLY MORE AMBITIOUS/);
  });
});

test("CouncilRunner.seed uses readDirective + buildDirectiveBlock helpers", () => {
  assert.match(
    COUNCIL_SRC,
    /readDirective\(cfg\)/,
    "seed must call readDirective(cfg) via shared helper",
  );
  assert.match(
    COUNCIL_SRC,
    /buildDirectiveBlock\(/,
    "seed must call buildDirectiveBlock via shared helper",
  );
});

test("CouncilRunner.runTurn forwards cfg.userDirective into buildCouncilPrompt", () => {
  assert.match(
    COUNCIL_SRC,
    /this\.runTurn\(agent, r, (3|effectiveRounds|cfg\.rounds), snapshot, cfg\.userDirective\)/,
    "loop must thread cfg.userDirective into runTurn",
  );
  assert.match(
    COUNCIL_SRC,
    /buildCouncilPrompt\(/,
    "runTurn must thread userDirective into buildCouncilPrompt",
  );
  assert.match(
    COUNCIL_SRC,
    /buildStandupPrompt\(/,
    "standup prompt builder must exist",
  );
});

test("CouncilRunner.runSynthesisPass forwards cfg.userDirective into buildCouncilSynthesisPrompt", () => {
  assert.match(
    ALL_COUNCIL_SRC,
    /buildCouncilSynthesisPrompt\(/,
    "synthesis pass must thread userDirective into the prompt builder",
  );
});
