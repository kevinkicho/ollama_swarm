import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { batchAdvancesUnmetCriteria } from "./auditorPendingCommits.js";
import type { ExitContract } from "./types.js";

describe("batchAdvancesUnmetCriteria (batch-fail gate)", () => {
  it("rejects zero writes", () => {
    const r = batchAdvancesUnmetCriteria(undefined, [], new Set(["a.ts"]));
    assert.equal(r.ok, false);
    assert.match(r.reason, /zero files/);
  });

  it("accepts when no unmet criteria", () => {
    const contract: ExitContract = {
      missionStatement: "m",
      criteria: [
        {
          id: "c1",
          description: "done",
          expectedFiles: ["a.ts"],
          status: "met",
          addedAt: 0,
        },
      ],
    };
    const r = batchAdvancesUnmetCriteria(contract, ["a.ts"], new Set(["a.ts"]));
    assert.equal(r.ok, true);
  });

  it("rejects when writes miss unmet expectedFiles", () => {
    const contract: ExitContract = {
      missionStatement: "m",
      criteria: [
        {
          id: "c1",
          description: "need b",
          expectedFiles: ["b.ts"],
          status: "unmet",
          addedAt: 0,
        },
      ],
    };
    const r = batchAdvancesUnmetCriteria(contract, ["a.ts"], new Set(["a.ts"]));
    assert.equal(r.ok, false);
    assert.match(r.reason, /no unmet criterion/);
  });
});
