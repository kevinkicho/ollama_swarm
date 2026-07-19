import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractTabsFromHtml,
  buildTabInventories,
  renderTabInventoryBlock,
  extractRequestedTabTopics,
  tabSkipContradictsInventory,
  todoLikelyNeedsTabInventory,
} from "./tabInventory.js";

const SAMPLE_HTML = `
<div class="tabs" role="tablist" data-role="tab-bar">
  <div class="tab active" role="tab" tabindex="0" aria-selected="true" onclick="switchTab(0)">Cantor's Infinities</div>
  <div class="tab" role="tab" tabindex="0" onclick="switchTab(1)">Hilbert's Hotel</div>
  <div class="tab" role="tab" tabindex="0" onclick="switchTab(2)">Ordinals</div>
</div>
`;

describe("tabInventory", () => {
  it("extracts role=tab titles and switchTab indices", () => {
    const tabs = extractTabsFromHtml(SAMPLE_HTML);
    assert.equal(tabs.length, 3);
    assert.equal(tabs[0]!.title, "Cantor's Infinities");
    assert.equal(tabs[0]!.index, 0);
    assert.equal(tabs[2]!.title, "Ordinals");
    assert.equal(tabs[2]!.index, 2);
  });

  it("buildTabInventories + render includes ground-truth framing", () => {
    const inv = buildTabInventories({ "18_infinity.html": SAMPLE_HTML });
    assert.equal(inv.length, 1);
    assert.equal(inv[0]!.tabs.length, 3);
    const block = renderTabInventoryBlock(inv);
    assert.match(block, /GROUND TRUTH/);
    assert.match(block, /Hilbert's Hotel/);
    assert.match(block, /18_infinity\.html/);
  });

  it("todoLikelyNeedsTabInventory detects tab work", () => {
    assert.equal(
      todoLikelyNeedsTabInventory("Add 5 new tabs to 14_diff_geometry.html", ["14_diff_geometry.html"]),
      true,
    );
    assert.equal(todoLikelyNeedsTabInventory("fix typo in utils", ["src/utils.ts"]), false);
  });

  it("extractRequestedTabTopics pulls quoted and list topics", () => {
    const topics = extractRequestedTabTopics(
      'Add tabs for "Riemann curvature", geodesic deviation, and parallel transport with canvas',
    );
    assert.ok(topics.some((t) => /riemann/i.test(t)));
    assert.ok(topics.some((t) => /geodesic/i.test(t)));
  });

  it("tabSkipContradictsInventory catches false already-done skip", () => {
    const inv = buildTabInventories({ "f.html": SAMPLE_HTML });
    const r = tabSkipContradictsInventory(
      "The file already contains 12 tabs covering exterior derivative and wedge product",
      'Add tabs for "Riemann curvature" and "frame dragging"',
      inv,
    );
    assert.equal(r.contradicts, true);
    if (r.contradicts) {
      assert.ok(r.missing.some((m) => /riemann|frame/i.test(m)));
    }
  });

  it("tabSkipContradictsInventory allows skip when topics present", () => {
    const inv = buildTabInventories({ "f.html": SAMPLE_HTML });
    const r = tabSkipContradictsInventory(
      "already contains Hilbert's Hotel and Ordinals tabs",
      'Ensure tabs for "Hilbert\'s Hotel" and Ordinals exist',
      inv,
    );
    assert.equal(r.contradicts, false);
  });
});
