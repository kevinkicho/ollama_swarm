// T-Item-CouncilRec (2026-05-04): tests for council vote/judge
// reconcile-policy helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tallyVotes,
  buildVotePrompt,
  parseVoteResponse,
  buildJudgePickPrompt,
} from "./councilReconcile.js";

test("tallyVotes — empty input → null winner", () => {
  const got = tallyVotes([], [1, 2, 3]);
  assert.equal(got.winnerIndex, null);
  assert.equal(got.totalVotes, 0);
});

test("tallyVotes — single vote → that agent wins", () => {
  const got = tallyVotes(
    [{ voterIndex: 1, votedForIndex: 2, rationale: "x" }],
    [1, 2, 3],
  );
  assert.equal(got.winnerIndex, 2);
  assert.equal(got.totalVotes, 1);
});

test("tallyVotes — most-voted wins", () => {
  const votes = [
    { voterIndex: 1, votedForIndex: 2, rationale: "" },
    { voterIndex: 2, votedForIndex: 3, rationale: "" },
    { voterIndex: 3, votedForIndex: 2, rationale: "" },
  ];
  const got = tallyVotes(votes, [1, 2, 3]);
  assert.equal(got.winnerIndex, 2);
  assert.equal(got.countsByIndex.get(2), 2);
  assert.equal(got.countsByIndex.get(3), 1);
});

test("tallyVotes — tie broken by lowest agent index", () => {
  const votes = [
    { voterIndex: 1, votedForIndex: 3, rationale: "" },
    { voterIndex: 3, votedForIndex: 2, rationale: "" },
  ];
  const got = tallyVotes(votes, [1, 2, 3]);
  // Both 2 and 3 have one vote; lowest index (2) wins
  assert.equal(got.winnerIndex, 2);
});

test("tallyVotes — self-vote counted as abstention", () => {
  const got = tallyVotes(
    [{ voterIndex: 2, votedForIndex: 2, rationale: "x" }],
    [1, 2, 3],
  );
  assert.equal(got.winnerIndex, null);
  assert.equal(got.abstentions, 1);
  assert.equal(got.totalVotes, 0);
});

test("tallyVotes — null vote counted as abstention", () => {
  const got = tallyVotes(
    [{ voterIndex: 1, votedForIndex: null, rationale: "" }],
    [1, 2, 3],
  );
  assert.equal(got.abstentions, 1);
});

test("tallyVotes — vote for unknown agent index counted as abstention", () => {
  const got = tallyVotes(
    [{ voterIndex: 1, votedForIndex: 99, rationale: "" }],
    [1, 2, 3],
  );
  assert.equal(got.abstentions, 1);
  assert.equal(got.winnerIndex, null);
});

test("buildVotePrompt — includes all OTHER drafts + bans self-vote", () => {
  const out = buildVotePrompt({
    voterIndex: 2,
    drafts: [
      { agentIndex: 1, text: "draft from 1" },
      { agentIndex: 2, text: "draft from 2 (self)" },
      { agentIndex: 3, text: "draft from 3" },
    ],
  });
  assert.match(out, /Agent 2/);
  assert.match(out, /draft from 1/);
  // Note: the prompt includes ALL drafts including self (the model
  // sees them all to compare). The "no self vote" rule is in the
  // instruction text + the integer ≠ 2 schema constraint.
  assert.match(out, /may NOT vote for yourself/);
  assert.match(out, /integer ≠ 2/);
});

test("buildVotePrompt — includes directive when set", () => {
  const out = buildVotePrompt({
    voterIndex: 1,
    drafts: [],
    userDirective: "Improve the auth flow",
  });
  assert.match(out, /Improve the auth flow/);
});

test("parseVoteResponse — strict JSON happy path", () => {
  const got = parseVoteResponse(
    '{"votedForIndex": 3, "rationale": "best evidence"}',
    1,
  );
  assert.equal(got.votedForIndex, 3);
  assert.equal(got.rationale, "best evidence");
});

test("parseVoteResponse — fenced JSON tolerated", () => {
  const got = parseVoteResponse(
    '```json\n{"votedForIndex": 2, "rationale": "x"}\n```',
    1,
  );
  assert.equal(got.votedForIndex, 2);
});

test("parseVoteResponse — self-vote rejected (returns null)", () => {
  const got = parseVoteResponse('{"votedForIndex": 1, "rationale": ""}', 1);
  assert.equal(got.votedForIndex, null);
});

test("parseVoteResponse — non-integer rejected", () => {
  assert.equal(
    parseVoteResponse('{"votedForIndex": "two", "rationale": ""}', 1).votedForIndex,
    null,
  );
});

test("parseVoteResponse — garbage input returns null", () => {
  assert.equal(parseVoteResponse("blah blah", 1).votedForIndex, null);
  assert.equal(parseVoteResponse("", 1).votedForIndex, null);
});

test("buildJudgePickPrompt — requires WINNER header + includes drafts", () => {
  const out = buildJudgePickPrompt({
    drafts: [
      { agentIndex: 1, text: "draft A" },
      { agentIndex: 2, text: "draft B" },
    ],
    userDirective: "Ship a plan",
  });
  assert.match(out, /WINNER: agent-/);
  assert.match(out, /PICK ONE/);
  assert.match(out, /draft A/);
  assert.match(out, /draft B/);
  assert.match(out, /Ship a plan/);
});

test("parseVoteResponse — JSON embedded in surrounding prose", () => {
  const got = parseVoteResponse(
    'Here is my pick:\n{"votedForIndex": 3, "rationale": "clear"}\nHope this helps',
    1,
  );
  assert.equal(got.votedForIndex, 3);
});
