import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPresetTipFields } from "./PresetTooltip.js";
import type { SwarmPreset } from "./PresetExtras.js";

const SAMPLE: SwarmPreset = {
  id: "council",
  label: "Council",
  summary: "Independent drafts, then reveal and revise.",
  min: 3,
  max: 8,
  recommended: 5,
  recommendedModel: "deepseek-v4-flash:cloud",
  status: "active",
  directive: "honored",
  useCases: ["deliberation", "research"],
};

describe("buildPresetTipFields", () => {
  it("includes structured metadata rows", () => {
    const fields = buildPresetTipFields(SAMPLE);
    assert.deepEqual(
      fields.map((f) => f.label),
      ["id", "status", "agents", "model", "directive", "use cases", "about"],
    );
    assert.equal(fields.find((f) => f.label === "id")?.value, "council");
    assert.equal(fields.find((f) => f.label === "agents")?.value, "3–8 (rec 5)");
    assert.equal(fields.find((f) => f.label === "about")?.multiline, true);
  });

  it("omits use cases row when absent", () => {
    const fields = buildPresetTipFields({ ...SAMPLE, useCases: undefined });
    assert.deepEqual(
      fields.map((f) => f.label),
      ["id", "status", "agents", "model", "directive", "about"],
    );
  });
});