import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ToolDispatcher } from "./ToolDispatcher.js";

describe("propose_hunks tool", () => {
  it("dry-runs replace_between and apply writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ph-"));
    await fs.writeFile(
      path.join(root, "roadmap.md"),
      "# T\n\n## A\nhold\n\n## B\nmid\n\n## C\nend\n",
      "utf8",
    );
    const d = new ToolDispatcher("swarm-builder", root);
    const dry = await d.dispatch({
      tool: "propose_hunks",
      args: {
        hunks: [
          {
            op: "replace_between",
            file: "roadmap.md",
            start: "## B",
            endExclusive: "## C",
            replace: "## B\nnew\n\n",
          },
        ],
      },
    });
    assert.equal(dry.ok, true);
    const before = await fs.readFile(path.join(root, "roadmap.md"), "utf8");
    assert.match(before, /mid/);

    const applied = await d.dispatch({
      tool: "propose_hunks",
      args: {
        apply: true,
        hunks: [
          {
            op: "replace_between",
            file: "roadmap.md",
            start: "## B",
            endExclusive: "## C",
            replace: "## B\nnew\n\n",
          },
        ],
      },
    });
    assert.equal(applied.ok, true);
    const after = await fs.readFile(path.join(root, "roadmap.md"), "utf8");
    assert.match(after, /## B\nnew/);
    assert.doesNotMatch(after, /mid/);
    assert.match(after, /## C/);
  });
});
