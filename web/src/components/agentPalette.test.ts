import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hueForAgent, agentBubblePalette } from "../components/agentPalette.js";

describe("hueForAgent", () => {
  it("returns hue for index 1", () => {
    assert.equal(hueForAgent(1), 140);
  });

  it("returns hue for index 2", () => {
    assert.equal(hueForAgent(2), 200);
  });

  it("wraps around for index > palette length", () => {
    assert.equal(hueForAgent(9), 140); // (9-1)%8=0→140
    assert.equal(hueForAgent(10), 200); // (10-1)%8=1→200
  });

  it("defaults index undefined to 1", () => {
    assert.equal(hueForAgent(undefined), 140);
  });

  it("returns 200 as fallback for index 0 (negative array access)", () => {
    // (0-1) = -1, AGENT_HUE[-1] is undefined, ?? 200
    assert.equal(hueForAgent(0), 200);
  });
});

describe("agentBubblePalette", () => {
  it("returns done palette for isDone=true", () => {
    const palette = agentBubblePalette(140, true);
    assert.ok(palette.border.includes("hsl("));
    assert.ok(palette.background.includes("hsl("));
    assert.ok(palette.border.includes("22%"));
    assert.ok(palette.background.includes("10%"));
  });

  it("returns active palette for isDone=false", () => {
    const palette = agentBubblePalette(140, false);
    assert.ok(palette.border.includes("hsl("));
    assert.ok(palette.border.includes("30%"));
    assert.ok(palette.background.includes("12%"));
  });

  it("uses the provided hue value", () => {
    const palette = agentBubblePalette(320, false);
    assert.ok(palette.border.includes("320"));
    assert.ok(palette.accent.includes("320"));
  });

  it("done and active palettes differ", () => {
    const done = agentBubblePalette(200, true);
    const active = agentBubblePalette(200, false);
    assert.notEqual(done.border, active.border);
    assert.notEqual(done.background, active.background);
  });

  it("has all required palette keys", () => {
    const palette = agentBubblePalette(140, false);
    const keys = ["border", "background", "header", "accent"];
    for (const key of keys) {
      assert.ok(typeof (palette as unknown as Record<string, unknown>)[key] === "string");
    }
  });
});
