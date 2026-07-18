import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBrainEffects, effectAllowed } from "./effects.js";

describe("brain OS effects", () => {
  it("observer cannot complete todos", () => {
    assert.equal(
      effectAllowed({ type: "board_complete", todoId: "t1", reason: "x" }, "observer"),
      false,
    );
    assert.equal(
      effectAllowed({ type: "append_system", text: "hi" }, "observer"),
      true,
    );
  });

  it("board_officer can skip", async () => {
    const skipped: string[] = [];
    const r = await applyBrainEffects(
      [{ type: "board_skip", todoId: "t9", reason: "already done" }],
      {
        privilege: "board_officer",
        appendSystem: () => {},
        skipTodo: (id) => {
          skipped.push(id);
        },
      },
    );
    assert.equal(r.applied, 1);
    assert.deepEqual(skipped, ["t9"]);
  });
});
