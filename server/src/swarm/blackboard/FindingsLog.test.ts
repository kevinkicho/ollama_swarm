// V2 cutover Phase 2c-pre tests: FindingsLog (extracted from V1
// Board). Append-only log of diagnostic notes from the auditor +
// replanner. Three methods (post / list / clear) — small surface,
// straightforward semantics.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FindingsLog } from "./FindingsLog.js";

describe("FindingsLog — post", () => {
  it("returns a defensive copy of the stored finding", () => {
    const log = new FindingsLog();
    const f = log.post({ agentId: "a-1", text: "hello", createdAt: 100 });
    f.text = "MUTATED";
    const fromList = log.list();
    assert.equal(fromList[0].text, "hello");
  });

  it("uses the supplied genId when provided (deterministic in tests)", () => {
    let n = 0;
    const log = new FindingsLog({ genId: () => `f${++n}` });
    const a = log.post({ agentId: "a", text: "first", createdAt: 1 });
    const b = log.post({ agentId: "a", text: "second", createdAt: 2 });
    assert.equal(a.id, "f1");
    assert.equal(b.id, "f2");
  });

  it("throws on empty / whitespace-only text", () => {
    const log = new FindingsLog();
    assert.throws(() => log.post({ agentId: "a", text: "", createdAt: 1 }), /cannot be empty/);
    assert.throws(() => log.post({ agentId: "a", text: "   ", createdAt: 1 }), /cannot be empty/);
    assert.throws(() => log.post({ agentId: "a", text: "\n\t", createdAt: 1 }), /cannot be empty/);
  });
});

describe("FindingsLog — list", () => {
  it("returns findings in createdAt ascending order regardless of insertion order", () => {
    const log = new FindingsLog();
    log.post({ agentId: "a", text: "third", createdAt: 300 });
    log.post({ agentId: "a", text: "first", createdAt: 100 });
    log.post({ agentId: "a", text: "second", createdAt: 200 });
    const out = log.list().map((f) => f.text);
    assert.deepEqual(out, ["first", "second", "third"]);
  });

  it("returns defensive copies — mutating the list doesn't corrupt internal state", () => {
    const log = new FindingsLog();
    log.post({ agentId: "a", text: "one", createdAt: 1 });
    const list = log.list();
    list[0].text = "MUTATED";
    list.push({ id: "fake", agentId: "a", text: "injected", createdAt: 999 });
    const fresh = log.list();
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].text, "one");
  });

  it("returns an empty array when no findings posted", () => {
    const log = new FindingsLog();
    assert.deepEqual(log.list(), []);
  });
});

describe("FindingsLog — clear", () => {
  it("empties the log + lets fresh posts start clean", () => {
    const log = new FindingsLog();
    log.post({ agentId: "a", text: "before", createdAt: 1 });
    log.post({ agentId: "a", text: "before2", createdAt: 2 });
    log.clear();
    assert.deepEqual(log.list(), []);
    log.post({ agentId: "a", text: "after", createdAt: 100 });
    const out = log.list();
    assert.equal(out.length, 1);
    assert.equal(out[0].text, "after");
  });

  it("clear is idempotent on an empty log", () => {
    const log = new FindingsLog();
    log.clear();
    log.clear();
    assert.deepEqual(log.list(), []);
  });
});
