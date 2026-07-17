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

  it("returns structured ApplyMissReport on replace miss", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ph-miss-"));
    await fs.writeFile(
      path.join(root, "note.md"),
      "# Title\n\nHello world\n\n## Section\nbody\n",
      "utf8",
    );
    const d = new ToolDispatcher("swarm-builder", root);
    const miss = await d.dispatch({
      tool: "propose_hunks",
      args: {
        hunks: [
          {
            op: "replace",
            file: "note.md",
            search: "this text is not in the file at all",
            replace: "replacement",
          },
        ],
      },
    });
    assert.equal(miss.ok, false);
    if (miss.ok) return;
    const payload = JSON.parse(miss.error) as {
      ok: boolean;
      reason: string;
      miss: {
        kind: string;
        file: string;
        nearbyExcerpt?: string;
        uniqueCandidates?: string[];
        message?: string;
      } | null;
      nearby?: Record<string, string>;
    };
    assert.equal(payload.ok, false);
    assert.ok(payload.miss, "expected structured miss");
    assert.equal(payload.miss!.file, "note.md");
    assert.equal(payload.miss!.kind, "search_not_found");
    assert.ok(
      (payload.miss!.nearbyExcerpt && payload.miss!.nearbyExcerpt.length > 0) ||
        (payload.nearby && Object.keys(payload.nearby).length > 0),
    );
  });
});
