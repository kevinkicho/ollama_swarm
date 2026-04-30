import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, createSessionForTest } from "./Session.js";

test("createSession — generates a uuid id", () => {
  const s = createSession("glm-5.1:cloud");
  assert.equal(typeof s.id, "string");
  assert.ok(s.id.length >= 32, `expected uuid-length id, got ${s.id}`);
  assert.equal(s.model, "glm-5.1:cloud");
});

test("createSession — every call returns a fresh AbortController + unique id", () => {
  const a = createSession("test");
  const b = createSession("test");
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.abortController, b.abortController);
});

test("createSession — abortController.signal starts unaborted", () => {
  const s = createSession("test");
  assert.equal(s.abortController.signal.aborted, false);
});

test("createSession — abortController.abort flips signal.aborted", () => {
  const s = createSession("test");
  s.abortController.abort();
  assert.equal(s.abortController.signal.aborted, true);
});

test("createSessionForTest — uses the supplied id verbatim", () => {
  const s = createSessionForTest("anthropic/claude-opus-4-7", "fixed-id-123");
  assert.equal(s.id, "fixed-id-123");
  assert.equal(s.model, "anthropic/claude-opus-4-7");
  assert.equal(s.createdAt, 0);
});
