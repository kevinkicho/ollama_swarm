// T-Item-2 (2026-05-04): unit tests for DebateStream tag-and-fork
// + cross-stream judge prompt + parser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DebateStream } from "./DebateStream.js";
import {
  buildCrossStreamJudgePrompt,
  parseCrossStreamPick,
} from "./DebateJudgeRunner.js";
import type { TranscriptEntry } from "../types.js";
import type { Agent } from "../services/AgentManager.js";

function fakeAgent(index: number): Agent {
  return {
    id: `agent-${index}`,
    index,
    port: 4096 + index,
    sessionId: `sess-${index}`,
    process: undefined as never,
  } as unknown as Agent;
}

test("DebateStream — appendEntry tags entry with streamId on both views", () => {
  const stream = new DebateStream({
    id: "stream-1",
    proposition: "X is good",
    pro: fakeAgent(1),
    con: fakeAgent(2),
  });
  const main: TranscriptEntry[] = [];
  const entry: TranscriptEntry = {
    id: "e1",
    role: "agent",
    text: "hi",
    ts: 1,
    agentId: "agent-1",
    agentIndex: 1,
  };
  stream.appendEntry(entry, (e) => main.push(e));
  assert.equal(main.length, 1);
  assert.equal(main[0].streamId, "stream-1");
  assert.equal(stream.transcript.length, 1);
  assert.equal(stream.transcript[0].streamId, "stream-1");
});

test("DebateStream — entries from one stream don't leak into another's local view", () => {
  const s1 = new DebateStream({
    id: "stream-1",
    proposition: "P1",
    pro: fakeAgent(1),
    con: fakeAgent(2),
  });
  const s2 = new DebateStream({
    id: "stream-2",
    proposition: "P2",
    pro: fakeAgent(1),
    con: fakeAgent(2),
  });
  const main: TranscriptEntry[] = [];
  s1.appendEntry(
    { id: "e1", role: "agent", text: "from s1", ts: 1 },
    (e) => main.push(e),
  );
  s2.appendEntry(
    { id: "e2", role: "agent", text: "from s2", ts: 2 },
    (e) => main.push(e),
  );
  // Main has both; each stream has only its own
  assert.equal(main.length, 2);
  assert.equal(s1.transcript.length, 1);
  assert.equal(s1.transcript[0].text, "from s1");
  assert.equal(s2.transcript.length, 1);
  assert.equal(s2.transcript[0].text, "from s2");
});

test("DebateStream — does not mutate caller's input entry", () => {
  const stream = new DebateStream({
    id: "stream-1",
    proposition: "X",
    pro: fakeAgent(1),
    con: fakeAgent(2),
  });
  const original: TranscriptEntry = {
    id: "e1",
    role: "agent",
    text: "hi",
    ts: 1,
  };
  stream.appendEntry(original, () => {});
  // Original should not have streamId set
  assert.equal(original.streamId, undefined);
});

test("buildCrossStreamJudgePrompt — includes all stream verdicts", () => {
  const out = buildCrossStreamJudgePrompt({
    streams: [
      {
        id: "stream-1",
        proposition: "Use bcrypt",
        verdict: {
          winner: "pro",
          confidence: "high",
          proStrongest: "Industry standard",
          conStrongest: "Slow per-login",
          proWeakest: "",
          conWeakest: "",
          decisive: "Standard wins on auditability",
          nextAction: "Migrate auth",
        },
      },
      {
        id: "stream-2",
        proposition: "Use argon2",
        verdict: {
          winner: "con",
          confidence: "medium",
          proStrongest: "More memory-hard",
          conStrongest: "No major libs",
          proWeakest: "",
          conWeakest: "",
          decisive: "Library availability tips",
          nextAction: "Stay with bcrypt",
        },
      },
    ],
  });
  assert.match(out, /stream-1/);
  assert.match(out, /stream-2/);
  assert.match(out, /Use bcrypt/);
  assert.match(out, /Use argon2/);
  assert.match(out, /Output STRICT JSON/);
  assert.match(out, /winnerStreamId/);
});

test("buildCrossStreamJudgePrompt — flags streams that didn't settle", () => {
  const out = buildCrossStreamJudgePrompt({
    streams: [
      {
        id: "stream-1",
        proposition: "P1",
        verdict: {
          winner: "pro",
          confidence: "high",
          proStrongest: "ok",
          conStrongest: "",
          proWeakest: "",
          conWeakest: "",
          decisive: "",
          nextAction: "do thing",
        },
      },
      { id: "stream-2", proposition: "P2", verdict: null },
    ],
  });
  assert.match(out, /stream-2/);
  assert.match(out, /did not settle/);
});

test("parseCrossStreamPick — strict JSON happy path", () => {
  const got = parseCrossStreamPick(
    '{"winnerStreamId": "stream-2", "rationale": "bcrypt has clearest tradeoff"}',
    ["stream-1", "stream-2", "stream-3"],
  );
  assert.deepEqual(got, {
    winnerStreamId: "stream-2",
    rationale: "bcrypt has clearest tradeoff",
  });
});

test("parseCrossStreamPick — fenced JSON tolerated", () => {
  const got = parseCrossStreamPick(
    '```json\n{"winnerStreamId": "stream-1", "rationale": "X"}\n```',
    ["stream-1"],
  );
  assert.equal(got?.winnerStreamId, "stream-1");
});

test("parseCrossStreamPick — rejects unknown stream id", () => {
  const got = parseCrossStreamPick(
    '{"winnerStreamId": "stream-99", "rationale": "x"}',
    ["stream-1", "stream-2"],
  );
  assert.equal(got, null);
});

test("parseCrossStreamPick — returns null on garbage input", () => {
  assert.equal(parseCrossStreamPick("not json", ["stream-1"]), null);
  assert.equal(parseCrossStreamPick("", ["stream-1"]), null);
  assert.equal(parseCrossStreamPick("{}", ["stream-1"]), null);
});

test("parseCrossStreamPick — empty rationale tolerated", () => {
  const got = parseCrossStreamPick(
    '{"winnerStreamId": "stream-1"}',
    ["stream-1"],
  );
  assert.equal(got?.winnerStreamId, "stream-1");
  assert.equal(got?.rationale, "");
});

test("parseCrossStreamPick — when validIds empty, accepts any string id", () => {
  // Defensive: caller may pass empty validIds when streams couldn't be
  // enumerated; in that case skip the membership check so we still
  // return SOMETHING the caller can act on.
  const got = parseCrossStreamPick(
    '{"winnerStreamId": "freeform-id", "rationale": "x"}',
    [],
  );
  assert.equal(got?.winnerStreamId, "freeform-id");
});
