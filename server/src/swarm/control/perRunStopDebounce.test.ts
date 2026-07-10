import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PerRunStopDebounce } from "./perRunStopDebounce.js";
import { decideStopAction } from "../drainStopPolicy.js";

describe("PerRunStopDebounce", () => {
  it("isolates stop clicks across runIds (no cross-run double-click kill)", () => {
    const map = new PerRunStopDebounce();
    const t0 = 1_000_000;
    // First click on A → drain
    const a1 = decideStopAction({ now: t0, lastStopAt: map.get("run-a") });
    assert.equal(a1.action, "drain");
    map.touch("run-a", t0);

    // First click on B shortly after must still be drain (not kill via A's timestamp)
    const b1 = decideStopAction({ now: t0 + 100, lastStopAt: map.get("run-b") });
    assert.equal(b1.action, "drain");
    map.touch("run-b", t0 + 100);

    // Second click on A within window → kill
    const a2 = decideStopAction({ now: t0 + 500, lastStopAt: map.get("run-a") });
    assert.equal(a2.action, "kill");
  });

  it("retain drops finished runs", () => {
    const map = new PerRunStopDebounce();
    map.touch("gone", 1);
    map.touch("live", 2);
    map.retain(new Set(["live"]));
    assert.equal(map.get("gone"), null);
    assert.equal(map.get("live"), 2);
  });
});
