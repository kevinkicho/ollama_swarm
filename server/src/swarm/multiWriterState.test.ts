import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MultiWriterState,
  snapshotWorkingTreeAsWriteHunks,
} from "./multiWriterState.js";
import type { Agent } from "../services/AgentManager.js";

function fakeAgent(id: string, index: number): Agent {
  return { id, index, sessionId: "s", model: "m" } as Agent;
}

describe("multiWriterState git-native", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-mw-"));
    await fs.writeFile(path.join(tmp, "a.ts"), "export const a = 1;\n", "utf8");
    await fs.writeFile(path.join(tmp, "b.ts"), "export const b = 2;\n", "utf8");
  });

  after(async () => {
    try {
      await fs.rm(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("snapshotWorkingTreeAsWriteHunks reads disk files", async () => {
    const hunks = await snapshotWorkingTreeAsWriteHunks(tmp, ["a.ts", "missing.ts"]);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0]!.op, "write");
    assert.equal(hunks[0]!.file, "a.ts");
    assert.match((hunks[0] as { content: string }).content, /export const a/);
  });

  it("addProposal accepts workingTree envelope as write hunks", async () => {
    const state = new MultiWriterState({
      writeMode: "multi",
      clonePath: tmp,
    });
    const result = await state.addProposal(
      fakeAgent("agent-1", 1),
      JSON.stringify({
        workingTree: true,
        message: "update a",
        files: ["a.ts", "b.ts"],
      }),
    );
    assert.equal(result.skipped, false);
    assert.equal(result.fromWorkingTree, true);
    assert.equal(result.hunks.length, 2);
    assert.equal(state.proposalCount(), 1);
    assert.ok(result.hunks.every((h) => h.op === "write"));
  });

  it("addProposal still accepts classic hunks", async () => {
    const state = new MultiWriterState({
      writeMode: "multi",
      clonePath: tmp,
    });
    const result = await state.addProposal(
      fakeAgent("agent-2", 2),
      JSON.stringify({
        hunks: [
          { op: "replace", file: "a.ts", search: "a = 1", replace: "a = 2" },
        ],
      }),
    );
    assert.equal(result.skipped, false);
    assert.equal(result.fromWorkingTree, undefined);
    assert.equal(result.hunks.length, 1);
  });
});
