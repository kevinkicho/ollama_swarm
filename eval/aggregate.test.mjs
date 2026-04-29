import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateCell } from "./aggregate.mjs";

test("aggregateCell — single attempt: median == score, IQR collapses to that value", () => {
  const got = aggregateCell([{ ok: true, score: { total: 75 } }]);
  assert.equal(got.median, 75);
  assert.equal(got.p25, 75);
  assert.equal(got.p75, 75);
  assert.equal(got.passCount, 1);
  assert.equal(got.attemptCount, 1);
});

test("aggregateCell — five attempts at [60,70,80,90,100] gives median=80, p25=70, p75=90", () => {
  const rows = [60, 70, 80, 90, 100].map((s) => ({ ok: true, score: { total: s } }));
  const got = aggregateCell(rows);
  assert.equal(got.median, 80);
  assert.equal(got.p25, 70);
  assert.equal(got.p75, 90);
  assert.equal(got.passCount, 5); // all >= 60
  assert.equal(got.attemptCount, 5);
});

test("aggregateCell — pass threshold is score >= 60 AND ok=true", () => {
  const rows = [
    { ok: true, score: { total: 100 } }, // pass
    { ok: true, score: { total: 60 } },  // pass (boundary)
    { ok: true, score: { total: 59 } },  // fail (below)
    { ok: false, score: { total: 90 } }, // fail (not ok)
    { ok: true, score: { total: 0 } },   // fail
  ];
  const got = aggregateCell(rows);
  assert.equal(got.passCount, 2);
  assert.equal(got.attemptCount, 5);
});

test("aggregateCell — missing score defaults to 0", () => {
  const rows = [
    { ok: true }, // no score
    { ok: true, score: { total: 80 } },
  ];
  const got = aggregateCell(rows);
  assert.equal(got.median, 40); // (0 + 80) / 2
  assert.equal(got.passCount, 1);
});

test("aggregateCell — empty input gives all zeros without crash", () => {
  const got = aggregateCell([]);
  assert.equal(got.median, 0);
  assert.equal(got.p25, 0);
  assert.equal(got.p75, 0);
  assert.equal(got.passCount, 0);
  assert.equal(got.attemptCount, 0);
});

test("aggregateCell — three attempts at [50, 80, 80] gives median=80, p25=65, p75=80", () => {
  const rows = [50, 80, 80].map((s) => ({ ok: true, score: { total: s } }));
  const got = aggregateCell(rows);
  assert.equal(got.median, 80);
  assert.equal(got.p25, 65); // linear interp between idx 0 and idx 1
  assert.equal(got.p75, 80);
  assert.equal(got.passCount, 2); // 50 fails the >=60 threshold; 80,80 pass
});
