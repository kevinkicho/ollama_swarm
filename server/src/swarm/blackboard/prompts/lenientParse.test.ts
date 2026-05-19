import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lenientPreprocess, softCap } from "./lenientParse.js";

describe("lenientPreprocess", () => {
  it("returns non-object values unchanged", () => {
    assert.equal(lenientPreprocess(null), null);
    assert.equal(lenientPreprocess(42), 42);
    assert.equal(lenientPreprocess("hello"), "hello");
    assert.equal(lenientPreprocess(undefined), undefined);
  });

  it("truncates description exceeding maxDescription", () => {
    const item = { description: "a".repeat(600) };
    const result = lenientPreprocess(item, { maxDescription: 500 }) as any;
    assert.ok(result.description.length <= 500);
    assert.match(result.description, /\u2026$/);
  });

  it("leaves description alone when under max", () => {
    const item = { description: "short" };
    const result = lenientPreprocess(item, { maxDescription: 100 }) as any;
    assert.equal(result.description, "short");
  });

  it("leaves description alone when maxDescription not set", () => {
    const item = { description: "a".repeat(5000) };
    const result = lenientPreprocess(item, {}) as any;
    assert.equal(result.description.length, 5000);
  });

  it("truncates expectedFiles array exceeding maxExpectedFiles", () => {
    const item = { expectedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"] };
    const result = lenientPreprocess(item, { maxExpectedFiles: 2 }) as any;
    assert.deepEqual(result.expectedFiles, ["a.ts", "b.ts"]);
  });

  it("leaves expectedFiles alone when under max", () => {
    const item = { expectedFiles: ["a.ts"] };
    const result = lenientPreprocess(item, { maxExpectedFiles: 5 }) as any;
    assert.deepEqual(result.expectedFiles, ["a.ts"]);
  });

  it("ignores expectedFiles when not an array", () => {
    const item = { expectedFiles: "not-an-array" };
    const result = lenientPreprocess(item, { maxExpectedFiles: 2 }) as any;
    assert.equal(result.expectedFiles, "not-an-array");
  });

  it("truncates expectedAnchors array", () => {
    const item = { expectedAnchors: ["a1", "a2", "a3", "a4", "a5"] };
    const result = lenientPreprocess(item, { maxExpectedAnchors: 3 }) as any;
    assert.deepEqual(result.expectedAnchors, ["a1", "a2", "a3"]);
  });

  it("truncates expectedSymbols array", () => {
    const item = { expectedSymbols: ["s1", "s2", "s3", "s4", "s5", "s6"] };
    const result = lenientPreprocess(item, { maxExpectedSymbols: 4 }) as any;
    assert.deepEqual(result.expectedSymbols, ["s1", "s2", "s3", "s4"]);
  });

  it("truncates command string", () => {
    const item = { command: "npm run lint --fix --quiet --max-warnings=0".repeat(3) };
    const result = lenientPreprocess(item, { maxCommand: 50 }) as any;
    assert.equal(result.command.length, 50);
  });

  it("truncates rationale with ellipsis", () => {
    const item = { rationale: "x".repeat(400) };
    const result = lenientPreprocess(item, { maxRationale: 200 }) as any;
    assert.ok(result.rationale.length <= 200);
    assert.match(result.rationale, /\u2026$/);
  });

  it("truncates preferredTag", () => {
    const item = { preferredTag: "a".repeat(100) };
    const result = lenientPreprocess(item, { maxPreferredTag: 30 }) as any;
    assert.equal(result.preferredTag.length, 30);
  });

  it("truncates criteria array", () => {
    const item = { criteria: ["c1", "c2", "c3", "c4", "c5", "c6", "c7"] };
    const result = lenientPreprocess(item, { maxCriteria: 5 }) as any;
    assert.deepEqual(result.criteria, ["c1", "c2", "c3", "c4", "c5"]);
  });

  it("handles item with no matching fields (no-ops)", () => {
    const item = { foo: "bar", count: 42, nested: { deep: true } };
    const result = lenientPreprocess(item, {
      maxDescription: 100,
      maxExpectedFiles: 2,
    }) as any;
    assert.equal(result.foo, "bar");
    assert.equal(result.count, 42);
    assert.equal(result.nested.deep, true);
  });

  it("does not mutate the original object", () => {
    const item = { description: "a".repeat(600) };
    const result = lenientPreprocess(item, { maxDescription: 100 });
    assert.notEqual(result, item);
    assert.equal(item.description.length, 600);
  });

  it("handles all max options simultaneously", () => {
    const item = {
      description: "d".repeat(600),
      expectedFiles: ["1", "2", "3", "4"],
      expectedAnchors: ["a", "b", "c", "d", "e"],
      expectedSymbols: ["s1", "s2", "s3", "s4", "s5"],
      command: "c".repeat(300),
      rationale: "r".repeat(500),
      preferredTag: "t".repeat(80),
      criteria: ["1", "2", "3", "4", "5", "6"],
    };
    const result = lenientPreprocess(item, {
      maxDescription: 500,
      maxExpectedFiles: 2,
      maxExpectedAnchors: 3,
      maxExpectedSymbols: 4,
      maxCommand: 200,
      maxRationale: 200,
      maxPreferredTag: 50,
      maxCriteria: 5,
    }) as any;
    assert.ok(result.description.length <= 500);
    assert.equal(result.expectedFiles.length, 2);
    assert.equal(result.expectedAnchors.length, 3);
    assert.equal(result.expectedSymbols.length, 4);
    assert.equal(result.command.length, 200);
    assert.ok(result.rationale.length <= 200);
    assert.equal(result.preferredTag.length, 50);
    assert.equal(result.criteria.length, 5);
  });

  it("leaves description when exactly at max (no truncation)", () => {
    const item = { description: "a".repeat(500) };
    const result = lenientPreprocess(item, { maxDescription: 500 }) as any;
    assert.equal(result.description.length, 500);
  });

  it("truncates description when 1 over max", () => {
    const item = { description: "a".repeat(501) };
    const result = lenientPreprocess(item, { maxDescription: 500 }) as any;
    assert.ok(result.description.length <= 500);
  });

  it("handles empty description string", () => {
    const item = { description: "" };
    const result = lenientPreprocess(item, { maxDescription: 5 }) as any;
    assert.equal(result.description, "");
  });
});

describe("softCap", () => {
  it("slices array longer than max", () => {
    assert.deepEqual(softCap([1, 2, 3, 4, 5], 3), [1, 2, 3]);
  });

  it("returns array unchanged when length equals max", () => {
    const arr = [1, 2, 3];
    assert.deepEqual(softCap(arr, 3), [1, 2, 3]);
  });

  it("returns array unchanged when shorter than max", () => {
    const arr = [1, 2];
    assert.deepEqual(softCap(arr, 5), [1, 2]);
  });

  it("handles empty array", () => {
    assert.deepEqual(softCap([], 3), []);
  });

  it("handles max of 0", () => {
    assert.deepEqual(softCap([1, 2, 3], 0), []);
  });

  it("handles string array", () => {
    assert.deepEqual(softCap(["a", "b", "c", "d"], 2), ["a", "b"]);
  });

  it("handles max of 1", () => {
    assert.deepEqual(softCap([1, 2, 3], 1), [1]);
  });
});
