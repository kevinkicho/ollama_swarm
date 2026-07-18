// R11 (2026-05-04): tests for universal JSON repair.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  repairAndParseJson,
  stripFences,
  extractBalancedSpan,
  applySoftRepairs,
} from "./repairJson.js";

test("repairAndParseJson — strict valid JSON → strict strategy", () => {
  const got = repairAndParseJson('{"a": 1}');
  assert.equal(got?.strategy, "strict");
  assert.deepEqual(got?.value, { a: 1 });
});

test("repairAndParseJson — empty string → null", () => {
  assert.equal(repairAndParseJson(""), null);
});

test("repairAndParseJson — fenced ```json → fence-strip", () => {
  const got = repairAndParseJson('```json\n{"a": 1}\n```');
  assert.equal(got?.strategy, "fence-strip");
  assert.deepEqual(got?.value, { a: 1 });
});

test("repairAndParseJson — fenced bare ``` → fence-strip", () => {
  const got = repairAndParseJson('```\n{"a": 1}\n```');
  assert.equal(got?.strategy, "fence-strip");
  assert.deepEqual(got?.value, { a: 1 });
});

test("repairAndParseJson — prose around JSON object → balanced-span", () => {
  const got = repairAndParseJson(
    'Here is the verdict: {"score": 7, "reason": "ok"} — done.',
  );
  assert.equal(got?.strategy, "balanced-span");
  assert.deepEqual(got?.value, { score: 7, reason: "ok" });
});

test("repairAndParseJson — prose around JSON array → balanced-span", () => {
  const got = repairAndParseJson("Output: [1, 2, 3] — see above.");
  assert.equal(got?.strategy, "balanced-span");
  assert.deepEqual(got?.value, [1, 2, 3]);
});

test("repairAndParseJson — trailing comma → soft-repairs", () => {
  const got = repairAndParseJson('{"a": 1, "b": 2,}');
  assert.equal(got?.strategy, "soft-repairs");
  assert.deepEqual(got?.value, { a: 1, b: 2 });
});

test("repairAndParseJson — single-quoted keys/values → soft-repairs", () => {
  const got = repairAndParseJson("{'foo': 'bar', 'n': 1}");
  assert.equal(got?.strategy, "soft-repairs");
  assert.deepEqual(got?.value, { foo: "bar", n: 1 });
});

test("repairAndParseJson — missing closing brace → soft-repairs", () => {
  const got = repairAndParseJson('{"a": 1, "b": 2');
  assert.equal(got?.strategy, "soft-repairs");
  assert.deepEqual(got?.value, { a: 1, b: 2 });
});

test("repairAndParseJson — missing closing bracket → soft-repairs", () => {
  const got = repairAndParseJson('[1, 2, 3');
  assert.equal(got?.strategy, "soft-repairs");
  assert.deepEqual(got?.value, [1, 2, 3]);
});

test("repairAndParseJson — smart quotes → soft-repairs", () => {
  const got = repairAndParseJson('{“a”: “b”}');
  assert.equal(got?.strategy, "soft-repairs");
  assert.deepEqual(got?.value, { a: "b" });
});

test("repairAndParseJson — missing brace before op key (83dc5910)", () => {
  const raw =
    '{"hunks":[op":"replace","file":"a.ts","search":"x","replace":"y"]}';
  const got = repairAndParseJson(raw);
  assert.ok(got);
  const v = got!.value as { hunks: Array<{ op: string; file: string }> };
  assert.equal(v.hunks[0]!.op, "replace");
  assert.equal(v.hunks[0]!.file, "a.ts");
});

test("repairAndParseJson — unclosed ```json fence", () => {
  const raw =
    '```json\n{"hunks":[{"op":"replace","file":"a.ts","search":"x","replace":"y"}]}';
  const got = repairAndParseJson(raw);
  assert.ok(got);
  assert.ok(
    got!.strategy.includes("fence") ||
      got!.strategy.includes("soft") ||
      got!.strategy.includes("balanced") ||
      got!.strategy === "strict",
  );
  const v = got!.value as { hunks: unknown[] };
  assert.equal(v.hunks.length, 1);
});

test("repairAndParseJson — irrecoverable garbage → null", () => {
  assert.equal(repairAndParseJson("totally not json blah blah"), null);
});

test("repairAndParseJson — think tags before JSON → strip-think path", () => {
  const got = repairAndParseJson('<think>planning the edit</think>\n{"hunks":[]}');
  assert.ok(got);
  assert.match(got!.strategy, /strip-think|strict|balanced/);
  assert.deepEqual(got!.value, { hunks: [] });
});

test("repairAndParseJson — nested JSON → balanced-span includes whole thing", () => {
  const got = repairAndParseJson(
    'Result: {"outer": {"inner": [1, 2]}, "n": 3} done',
  );
  assert.equal(got?.strategy, "balanced-span");
  assert.deepEqual(got?.value, { outer: { inner: [1, 2] }, n: 3 });
});

test("stripFences — no fence → unchanged", () => {
  assert.equal(stripFences('{"a":1}'), '{"a":1}');
});

test("stripFences — ```json prefix → stripped", () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
});

test("stripFences — ```typescript prefix → stripped (lang-agnostic)", () => {
  assert.equal(stripFences('```typescript\n{"a":1}\n```'), '{"a":1}');
});

test("extractBalancedSpan — finds first {}", () => {
  assert.equal(extractBalancedSpan('prose {"a":1} more'), '{"a":1}');
});

test("extractBalancedSpan — handles nested braces", () => {
  assert.equal(
    extractBalancedSpan('{"o":{"i":1}} after'),
    '{"o":{"i":1}}',
  );
});

test("extractBalancedSpan — handles braces inside strings", () => {
  // The naive depth counter respects string boundaries.
  assert.equal(
    extractBalancedSpan('{"text": "foo { bar"}'),
    '{"text": "foo { bar"}',
  );
});

test("extractBalancedSpan — no brace → null", () => {
  assert.equal(extractBalancedSpan("plain text"), null);
});

test("applySoftRepairs — trailing comma stripped", () => {
  assert.equal(applySoftRepairs('{"a":1,}'), '{"a":1}');
});

test("applySoftRepairs — closing brace appended when missing", () => {
  assert.equal(applySoftRepairs('{"a":1'), '{"a":1}');
});

test("applySoftRepairs — order of close brackets follows open order (squares first)", () => {
  // [{... → needs }] suffix
  const got = applySoftRepairs('[{"a":1');
  // After running balance: 1 { open, 1 [ open
  // Tail builds: ] then } → suffix ]}
  assert.equal(got, '[{"a":1]}');
});

test("applySoftRepairs — already balanced → unchanged", () => {
  assert.equal(applySoftRepairs('{"a":1}'), '{"a":1}');
});

test("applySoftRepairs — preserves braces inside strings (no over-balance)", () => {
  const input = '{"text": "{stuff}"}';
  assert.equal(applySoftRepairs(input), input);
});
