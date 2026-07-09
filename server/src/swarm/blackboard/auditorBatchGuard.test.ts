import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { batchAdvancesUnmetCriteria } from "./auditorRunner.js";
import type { ExitContract } from "./types.js";

describe("batchAdvancesUnmetCriteria", () => {
  const contract: ExitContract = {
    missionStatement: "test",
    criteria: [
      {
        id: "c1",
        description: "panel registry",
        status: "unmet",
        expectedFiles: ["functions/src/panels/panelRegistry.js"],
      },
      {
        id: "c2",
        description: "market panel",
        status: "unmet",
        expectedFiles: ["functions/src/panels/marketPanels.js"],
      },
    ],
  };

  it("rejects zero-file batches", () => {
    const got = batchAdvancesUnmetCriteria(contract, [], new Set([".swarm-improvements/foo"]));
    assert.equal(got.ok, false);
    assert.match(got.reason, /zero files/);
  });

  it("rejects batches that touch no unmet expectedFiles", () => {
    const got = batchAdvancesUnmetCriteria(
      contract,
      [".swarm-improvements/pattern-cache.json"],
      new Set([".swarm-improvements/pattern-cache.json"]),
    );
    assert.equal(got.ok, false);
    assert.match(got.reason, /no unmet criterion expectedFiles/);
  });

  it("accepts batches that write an expected file", () => {
    const got = batchAdvancesUnmetCriteria(
      contract,
      ["functions/src/panels/panelRegistry.js"],
      new Set(["functions/src/panels/panelRegistry.js"]),
    );
    assert.equal(got.ok, true);
  });
});