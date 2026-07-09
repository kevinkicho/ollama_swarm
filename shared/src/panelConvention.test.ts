import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPanelConvention,
  findExistingSimilarPanel,
  inferMarketTabFromText,
  repathPanelToMarketTab,
} from "./panelConvention.js";

describe("panelConvention", () => {
  it("infers market tab from description", () => {
    assert.equal(inferMarketTabFromText("Create panel for the bonds tab"), "bonds");
    assert.equal(inferMarketTabFromText("credit tab IMF panel"), "credit");
  });

  it("repaths src/components panels to src/markets/{tab}/", () => {
    const out = applyPanelConvention(
      {
        description: "Create ImfFsiPanel for the credit tab.",
        expectedFiles: [
          "src/components/ImfFsiPanel.jsx",
          "src/__tests__/credit/ImfFsiPanel.test.jsx",
        ],
      },
      ["src/components/Foo.jsx", "src/markets/credit/ImfCreditPanel.jsx"],
    );
    assert.equal(out.action, "repath");
    if (out.action === "repath") {
      assert.equal(out.expectedFiles[0], "src/markets/credit/ImfFsiPanel.jsx");
    }
  });

  it("dedups ImfFsi against ImfFsiCapitalAdequacyPanel", () => {
    const repo = ["src/markets/credit/ImfFsiCapitalAdequacyPanel.jsx"];
    assert.equal(
      findExistingSimilarPanel("src/components/ImfFsiPanel.jsx", repo),
      "src/markets/credit/ImfFsiCapitalAdequacyPanel.jsx",
    );
    const out = applyPanelConvention(
      {
        description: "Create ImfFsiPanel for credit tab.",
        expectedFiles: ["src/components/ImfFsiPanel.jsx"],
      },
      repo,
    );
    assert.equal(out.action, "register-existing");
  });

  it("repathPanelToMarketTab", () => {
    assert.equal(
      repathPanelToMarketTab("src/components/BisDebtSecuritiesPanel.jsx", "bonds"),
      "src/markets/bonds/BisDebtSecuritiesPanel.jsx",
    );
  });
});