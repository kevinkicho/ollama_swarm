import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateProposedHunksStructural } from "./hunkStructuralValidate.js";

describe("validateProposedHunksStructural", () => {
  it("rejects lowercase <component /> after Component binding", () => {
    const r = validateProposedHunksStructural([
      {
        file: "src/hub/lazyMarketComponents.jsx",
        replace:
          "const Component = MarketComponents[marketId];\nreturn <component />;",
      },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /lowercase <component/i);
  });

  it("rejects orphan comma after closed array", () => {
    const r = validateProposedHunksStructural([
      {
        file: "src/hub/markets.config.js",
        replace: "];\n\n,\n  { marketId: 'imf' }",
      },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /closed array/i);
  });

  it("accepts valid Component JSX", () => {
    const r = validateProposedHunksStructural([
      {
        file: "src/hub/lazyMarketComponents.jsx",
        replace:
          "const Component = MarketComponents[marketId];\nreturn <Component />;",
      },
    ]);
    assert.equal(r.ok, true);
  });
});
