import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { staggerStart } from "./staggerStart.js";

describe("staggerStart", () => {
  it("returns PromiseSettledResult array in input order", async () => {
    const results = await staggerStart([10, 20, 30], async (n) => n * 2, 5);
    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((r) => (r.status === "fulfilled" ? r.value : null)),
      [20, 40, 60],
    );
  });

  it("staggers fn invocations: item[i] starts ~spacingMs*i later", async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    await staggerStart([0, 1, 2, 3], async () => {
      starts.push(Date.now() - t0);
    }, 100);
    // Item 0 should start at ~0ms, item 1 at ~100ms, etc. Jitter is
    // ±25%, so a 100ms nominal lands in [75, 125]ms. Allow generous
    // tolerance for test-runner scheduling noise.
    assert.ok(starts[0] < 30, `item 0 start: ${starts[0]}ms`);
    assert.ok(starts[1] >= 60 && starts[1] <= 170, `item 1 start: ${starts[1]}ms`);
    assert.ok(starts[2] >= 140 && starts[2] <= 320, `item 2 start: ${starts[2]}ms`);
    assert.ok(starts[3] >= 210 && starts[3] <= 450, `item 3 start: ${starts[3]}ms`);
  });

  it("captures rejection as a PromiseRejectedResult (does not throw)", async () => {
    const results = await staggerStart([1, 2, 3], async (n) => {
      if (n === 2) throw new Error("boom");
      return n * 10;
    }, 5);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(results[2].status, "fulfilled");
    if (results[1].status === "rejected") {
      assert.equal((results[1].reason as Error).message, "boom");
    }
  });

  it("is a no-op on empty input", async () => {
    const results = await staggerStart([], async () => 1);
    assert.deepEqual(results, []);
  });

  it("preserves index argument in the second param of fn", async () => {
    const seen: Array<{ item: string; index: number }> = [];
    await staggerStart(["a", "b", "c"], async (item, index) => {
      seen.push({ item, index });
    }, 5);
    // seen order will vary due to timing, but each entry should have
    // its matching item + index pair.
    assert.equal(seen.length, 3);
    const map = new Map(seen.map((s) => [s.item, s.index]));
    assert.equal(map.get("a"), 0);
    assert.equal(map.get("b"), 1);
    assert.equal(map.get("c"), 2);
  });
});
