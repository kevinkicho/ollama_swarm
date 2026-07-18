/**
 * Council/UI dual-path smoke for 2010479c deliberate + hunk display.
 * No React mount — pure parsers used by transcript bubbles.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDeliberateEnvelopes } from "./deliberateParse.js";
import { tryParseWorkerHunks } from "@ollama-swarm/shared/workerHunks";

/** Live-shaped deliberate card from council draft stream. */
const LIVE_DELIBERATE = `
Looking at the draft criteria…

\`\`\`deliberate
subject: criterion-auth-flow
claim: login form validates empty password
stance: approve
why: matches existing AuthForm tests
evidence: src/auth/AuthForm.test.tsx, docs/auth.md
\`\`\`

Some trailing prose.
`;

const LIVE_DELIBERATE_UNCLOSED = `
\`\`\`deliberate
subject: criterion-2
claim: session cookie is HttpOnly
stance: challenge
why: draft never sets cookie flags
`;

describe("dual-path UI — deliberate envelopes (2010479c)", () => {
  it("parses closed deliberate fence into structured card fields", () => {
    const envs = parseDeliberateEnvelopes(LIVE_DELIBERATE);
    assert.equal(envs.length, 1);
    assert.equal(envs[0]!.subject, "criterion-auth-flow");
    assert.equal(envs[0]!.stance, "approve");
    assert.ok(envs[0]!.evidence.length >= 1);
  });

  it("salvages unclosed deliberate fence (stream cut mid-draft)", () => {
    const envs = parseDeliberateEnvelopes(LIVE_DELIBERATE_UNCLOSED);
    assert.equal(envs.length, 1);
    assert.equal(envs[0]!.stance, "challenge");
  });
});

describe("dual-path UI — worker hunk bubble parser", () => {
  it("renders replace_between with null endExclusive instead of raw JSON", () => {
    const raw = `\`\`\`json
{"hunks":[{"op":"replace_between","file":"a.ts","start":"// start","endExclusive":null,"replace":"// done"}]}
\`\`\``;
    const hunks = tryParseWorkerHunks(raw);
    assert.ok(hunks);
    assert.equal(hunks![0]!.op, "replace_between");
    assert.equal(hunks![0]!.endExclusive, undefined);
  });

  it("parses write op for full-file replacement cards", () => {
    const hunks = tryParseWorkerHunks(
      JSON.stringify({
        hunks: [{ op: "write", file: "b.ts", content: "export {}\n" }],
      }),
    );
    assert.ok(hunks);
    assert.equal(hunks![0]!.op, "write");
  });

  it("soft-repairs raw newlines inside hunk search strings", () => {
    const raw =
      '{"hunks":[{"op":"replace","file":"a.ts","search":"line1\nline2","replace":"x"}]}';
    const hunks = tryParseWorkerHunks(raw);
    assert.ok(hunks);
    assert.equal(hunks![0]!.search, "line1\nline2");
  });

  it("parses workingTree envelopes without inventing hunks", async () => {
    const { tryParseWorkerEnvelope } = await import("@ollama-swarm/shared/workerHunks");
    const raw = JSON.stringify({
      workingTree: true,
      message: "add helper",
      files: ["src/a.ts", "src/b.ts"],
    });
    const env = tryParseWorkerEnvelope(raw);
    assert.ok(env);
    assert.equal(env!.type, "workingTree");
    if (env!.type === "workingTree") {
      assert.equal(env.workingTree.files.length, 2);
      assert.match(env.workingTree.message, /add helper/);
    }
    assert.equal(tryParseWorkerHunks(raw), null);
  });
});
