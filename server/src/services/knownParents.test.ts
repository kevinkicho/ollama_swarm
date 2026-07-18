import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isJunkKnownParentPath,
  filterKnownParentPaths,
  mergeKnownParents,
} from "./knownParents.js";

describe("knownParents hygiene", () => {
  it("flags recover-me and server/logs run dirs as junk", () => {
    assert.equal(
      isJunkKnownParentPath(
        "C:\\Users\\kevin\\workspace\\ollama_swarm\\server\\logs\\recover-me-1784266554520",
      ),
      true,
    );
    assert.equal(
      isJunkKnownParentPath(
        "C:\\Users\\kevin\\workspace\\ollama_swarm\\server\\logs\\df1eab0b-f7e3-4724-9ff8-842bef332cc2",
      ),
      true,
    );
    assert.equal(
      isJunkKnownParentPath("C:\\Users\\kevin\\workspace\\kyahoofinance032926"),
      false,
    );
    assert.equal(isJunkKnownParentPath("C:\\Users\\kevin\\workspace"), false);
  });

  it("mergeKnownParents drops junk and keeps real workspaces under the cap", () => {
    const junk = Array.from({ length: 40 }, (_, i) =>
      `C:\\app\\server\\logs\\recover-me-${i}`,
    );
    const merged = mergeKnownParents(
      ["C:\\Users\\kevin\\workspace", ...junk.slice(0, 20)],
      ["C:\\Users\\kevin\\workspace\\kyahoofinance032926", ...junk.slice(20)],
    );
    assert.ok(merged.includes("C:\\Users\\kevin\\workspace"));
    assert.ok(merged.includes("C:\\Users\\kevin\\workspace\\kyahoofinance032926"));
    assert.equal(merged.every((p) => !isJunkKnownParentPath(p)), true);
    assert.ok(merged.length <= 32);
  });

  it("filterKnownParentPaths is identity for clean lists", () => {
    const clean = [
      "C:\\Users\\kevin\\workspace",
      "C:\\Users\\kevin\\workspace\\ktopologymath040226",
    ];
    assert.deepEqual(filterKnownParentPaths(clean), clean);
  });
});
