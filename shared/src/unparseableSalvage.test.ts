import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatUnparseableSalvageMessage,
  isUnparseableSalvageJson,
} from "./unparseableSalvage.js";

describe("unparseableSalvage", () => {
  it("detects compact and pretty sentinel JSON", () => {
    assert.equal(isUnparseableSalvageJson('{"_unparseable":true}'), true);
    assert.equal(isUnparseableSalvageJson('{\n  "_unparseable": true\n}'), true);
    assert.equal(isUnparseableSalvageJson('{"hunks":[]}'), false);
    assert.equal(isUnparseableSalvageJson("not json"), false);
  });

  it("formats a readable multi-line message", () => {
    const msg = formatUnparseableSalvageMessage({
      kind: "worker",
      parseError: "empty response",
    });
    assert.match(msg, /JSON salvage failed/i);
    assert.match(msg, /worker/);
    assert.match(msg, /empty response/);
  });
});
