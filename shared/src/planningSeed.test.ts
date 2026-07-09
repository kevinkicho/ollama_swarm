import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countSeedRichnessSignals,
  isSeedSufficientForDirectEmit,
} from "./planningSeed.js";

describe("planningSeed", () => {
  it("counts richness signals", () => {
    assert.equal(countSeedRichnessSignals({}), 0);
    assert.equal(
      countSeedRichnessSignals({
        endpointCatalogBlock: "routes",
        codeContextExcerpts: [{ path: "web/src/Foo.tsx" }],
        projectGraphSlice: "graph",
      }),
      3,
    );
  });

  it("requires fast path for direct emit", () => {
    const rich = {
      endpointCatalogBlock: "catalog",
      codeContextExcerpts: [{ path: "a.ts" }],
    };
    assert.equal(isSeedSufficientForDirectEmit(rich, { planningFastPath: false }), false);
    assert.equal(isSeedSufficientForDirectEmit(rich, { planningFastPath: true }), true);
  });

  it("allows direct emit with two non-catalog signals", () => {
    assert.equal(
      isSeedSufficientForDirectEmit(
        { projectGraphSlice: "g", priorMemoryRendered: "m" },
        { planningFastPath: true },
      ),
      true,
    );
  });
});