import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDeliberationTransaction,
  formatDeliberationTranscriptLine,
  recordDeliberation,
  readDeliberationLog,
} from "./deliberationLog.js";
import {
  parseDeliberateEnvelopes,
  buildDeliberationProtocolInstructionBlock,
} from "./deliberationProtocol.js";

describe("buildDeliberationTransaction", () => {
  it("fills schema and truncates long fields", () => {
    const tx = buildDeliberationTransaction({
      runId: "r1",
      layer: "hierarchy",
      subject: "todo-abc",
      claim: "x".repeat(2000),
      proposer: "worker",
      verdict: "deny",
      validationReason: "bad hunk",
    });
    assert.equal(tx.schemaVersion, 1);
    assert.equal(tx.verdict, "deny");
    assert.ok(tx.claim.length <= 800);
    assert.match(formatDeliberationTranscriptLine(tx), /\[deliberation:hierarchy\] DENY/);
  });
});

describe("recordDeliberation", () => {
  it("writes jsonl and invokes sinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "delib-"));
    const lines: string[] = [];
    const diags: unknown[] = [];
    const events: unknown[] = [];
    const tx = await recordDeliberation(
      {
        runId: "run-full-id-12345678",
        layer: "peer",
        subject: "vote winner",
        claim: "agent-2 has better evidence",
        proposer: "agent-1",
        validator: "agent-3",
        verdict: "approve",
        validationReason: "stronger file citations",
      },
      {
        clonePath: root,
        appendSystem: (m) => lines.push(m),
        logDiag: (e) => diags.push(e),
        emit: (e) => events.push(e),
      },
    );
    assert.equal(tx.verdict, "approve");
    assert.equal(lines.length, 1);
    assert.equal(events.length, 1);
    assert.equal(diags.length, 1);
    const rows = await readDeliberationLog(root, "run-full-id-12345678");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.subject, "vote winner");
  });
});

describe("parseDeliberateEnvelopes", () => {
  it("parses approve/deny stances", () => {
    const text = `
Some prose
\`\`\`deliberate
subject: fix predict_tc unpack
claim: agent-2 correctly identified the 3-tuple bug
stance: approve
why: matches extract_features return arity
evidence: scripts/predict_tc.py, tests/test_predict.py
to: agent-1
\`\`\`
`;
    const got = parseDeliberateEnvelopes(text);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.stance, "approve");
    assert.equal(got[0]!.evidence.length, 2);
    assert.equal(got[0]!.to, "agent-1");
  });

  it("skips incomplete envelopes", () => {
    assert.deepEqual(
      parseDeliberateEnvelopes("```deliberate\nstance: approve\n```"),
      [],
    );
  });
});

describe("buildDeliberationProtocolInstructionBlock", () => {
  it("documents stances", () => {
    const b = buildDeliberationProtocolInstructionBlock();
    assert.match(b, /approve \| deny \| challenge \| validate/);
    assert.match(b, /```deliberate/);
  });
});
