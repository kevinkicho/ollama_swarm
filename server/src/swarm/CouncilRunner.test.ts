import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCouncilPrompt } from "./CouncilRunner.js";
import type { TranscriptEntry } from "../types.js";

// The value of Council over round-robin is that within a round, no agent can
// see another agent's output. buildCouncilPrompt is the choke-point that
// enforces this — if a future refactor breaks it, these tests break.

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
    // "Agent 2" / "Agent 3" in the transcript BODY would mean a peer entry
    // leaked in. The prompt HEADER legitimately names the requesting agent
    // ("You are Agent 4"), so we check for the transcript-body format instead.
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

  it("announces the round is a draft round in round 1", () => {
    const prompt = buildCouncilPrompt(1, 1, 3, [system("seed")]);
    assert.match(prompt, /ROUND 1.*independent first draft/i);
    assert.match(prompt, /peer drafts hidden/i);
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

  it("announces the round is a revision round in round 2+", () => {
    const prompt = buildCouncilPrompt(1, 2, 3, [system("seed")]);
    assert.match(prompt, /ROUND 2.*revision/i);
    assert.match(prompt, /other agents' prior drafts/i);
  });

  it("still includes peers in round 3", () => {
    const snapshot: TranscriptEntry[] = [
      system("seed"),
      agent(2, "something important"),
    ];
    const prompt = buildCouncilPrompt(1, 3, 3, snapshot);
    assert.ok(prompt.includes("something important"));
    assert.match(prompt, /ROUND 3.*revision/i);
  });
});

describe("buildCouncilPrompt — general shape", () => {
  it("identifies the requesting agent in both the header and the closing line", () => {
    const prompt = buildCouncilPrompt(4, 1, 3, []);
    assert.ok(prompt.includes("You are Agent 4"));
    assert.ok(prompt.includes("Now respond as Agent 4."));
  });

  it("states the overall discussion goals", () => {
    const prompt = buildCouncilPrompt(1, 1, 3, []);
    assert.match(prompt, /1\. Figure out what this project is/);
    assert.match(prompt, /2\. Identify what is working/);
    assert.match(prompt, /3\. Propose one concrete next action/);
  });
});
