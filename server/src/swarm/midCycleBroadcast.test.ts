// Q9 (2026-05-04): tests for mid-cycle finding broadcast helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectBroadcastFindings,
  selectFindingsForMapper,
  buildCrossMapperContextBlock,
  HIGH_CONFIDENCE_THRESHOLD,
  MAX_BROADCAST_PER_MAPPER,
  type MapperFinding,
} from "./midCycleBroadcast.js";

function f(overrides: Partial<MapperFinding>): MapperFinding {
  return {
    fromMapperIndex: 1,
    text: "found a thing",
    confidence: HIGH_CONFIDENCE_THRESHOLD,
    ...overrides,
  };
}

test("selectBroadcastFindings — filters out below-threshold findings", () => {
  const got = selectBroadcastFindings([
    f({ fromMapperIndex: 1, confidence: HIGH_CONFIDENCE_THRESHOLD - 1 }),
    f({ fromMapperIndex: 2, confidence: HIGH_CONFIDENCE_THRESHOLD }),
    f({ fromMapperIndex: 3, confidence: 10 }),
  ]);
  assert.equal(got.length, 2);
});

test("selectFindingsForMapper — excludes findings from the receiving mapper", () => {
  const got = selectFindingsForMapper({
    pool: [
      f({ fromMapperIndex: 1, text: "self" }),
      f({ fromMapperIndex: 2, text: "other" }),
    ],
    receivingMapperIndex: 1,
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "other");
});

test("selectFindingsForMapper — respects maxFindings cap", () => {
  const pool = Array.from({ length: 10 }, (_, i) =>
    f({ fromMapperIndex: i + 2, text: `t${i}` }),
  );
  const got = selectFindingsForMapper({
    pool,
    receivingMapperIndex: 1,
    maxFindings: 3,
  });
  assert.equal(got.length, 3);
});

test("selectFindingsForMapper — uses default cap when none supplied", () => {
  const pool = Array.from({ length: MAX_BROADCAST_PER_MAPPER + 5 }, (_, i) =>
    f({ fromMapperIndex: i + 2, text: `t${i}` }),
  );
  const got = selectFindingsForMapper({
    pool,
    receivingMapperIndex: 1,
  });
  assert.equal(got.length, MAX_BROADCAST_PER_MAPPER);
});

test("selectFindingsForMapper — sorts by confidence desc then by from-index", () => {
  const got = selectFindingsForMapper({
    pool: [
      f({ fromMapperIndex: 5, confidence: 7, text: "low" }),
      f({ fromMapperIndex: 2, confidence: 9, text: "high-2" }),
      f({ fromMapperIndex: 3, confidence: 9, text: "high-3" }),
    ],
    receivingMapperIndex: 1,
  });
  assert.equal(got[0].text, "high-2", "highest confidence + lowest index first");
  assert.equal(got[1].text, "high-3");
  assert.equal(got[2].text, "low");
});

test("selectFindingsForMapper — filters below-threshold even from other mappers", () => {
  const got = selectFindingsForMapper({
    pool: [
      f({ fromMapperIndex: 2, confidence: HIGH_CONFIDENCE_THRESHOLD - 1 }),
      f({ fromMapperIndex: 3, confidence: HIGH_CONFIDENCE_THRESHOLD }),
    ],
    receivingMapperIndex: 1,
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].fromMapperIndex, 3);
});

test("buildCrossMapperContextBlock — empty findings → empty string", () => {
  assert.equal(buildCrossMapperContextBlock([]), "");
});

test("buildCrossMapperContextBlock — renders findings with from + confidence + file", () => {
  const block = buildCrossMapperContextBlock([
    f({
      fromMapperIndex: 2,
      text: "auth bug",
      confidence: 9,
      filePath: "src/auth.ts",
    }),
  ]);
  assert.match(block, /Cross-mapper context/);
  assert.match(block, /From Mapper 2/);
  assert.match(block, /confidence 9\/10/);
  assert.match(block, /\[src\/auth\.ts\]/);
  assert.match(block, /auth bug/);
});

test("buildCrossMapperContextBlock — omits file label when no filePath", () => {
  const block = buildCrossMapperContextBlock([
    f({ fromMapperIndex: 2, text: "general", confidence: 9 }),
  ]);
  assert.equal(block.includes("["), block.includes("[End cross-mapper"));
});
