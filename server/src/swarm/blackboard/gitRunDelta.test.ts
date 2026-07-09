import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { diffPorcelain, parsePorcelainLines, pathFromPorcelainLine } from "./gitRunDelta.js";

describe("pathFromPorcelainLine", () => {
  it("parses modified tracked files", () => {
    assert.equal(pathFromPorcelainLine(" M src/foo.ts"), "src/foo.ts");
  });

  it("parses untracked files", () => {
    assert.equal(pathFromPorcelainLine("?? board-final.json"), "board-final.json");
  });

  it("parses renames", () => {
    assert.equal(pathFromPorcelainLine("R  old.ts -> new.ts"), "new.ts");
  });
});

describe("diffPorcelain", () => {
  it("returns zero when end state matches baseline (resumed clone)", () => {
    const baseline = " M GOVERNMENT_API_CATALOG.md\n?? board-final.json";
    const current = " M GOVERNMENT_API_CATALOG.md\n?? board-final.json";
    const d = diffPorcelain(baseline, current);
    assert.equal(d.changedFiles, 0);
    assert.equal(d.porcelain, "");
  });

  it("counts only new dirty paths introduced during the run", () => {
    const baseline = " M existing.js";
    const current = " M existing.js\n?? new-route.js";
    const d = diffPorcelain(baseline, current);
    assert.equal(d.changedFiles, 1);
    assert.match(d.porcelain, /new-route\.js/);
    assert.doesNotMatch(d.porcelain, /existing\.js/);
  });

  it("counts status transitions on a path", () => {
    const baseline = "?? draft.js";
    const current = "A  draft.js";
    const d = diffPorcelain(baseline, current);
    assert.equal(d.changedFiles, 1);
    assert.match(d.porcelain, /draft\.js/);
  });

  it("ignores unchanged pre-existing dirty files even when content changed", () => {
    const baseline = " M same-status.js";
    const current = " M same-status.js";
    assert.equal(diffPorcelain(baseline, current).changedFiles, 0);
  });
});

describe("parsePorcelainLines", () => {
  it("indexes by path", () => {
    const m = parsePorcelainLines(" M a.ts\n?? b.ts");
    assert.equal(m.size, 2);
    assert.equal(m.get("a.ts")?.xy, " M");
    assert.equal(m.get("b.ts")?.xy, "??");
  });
});