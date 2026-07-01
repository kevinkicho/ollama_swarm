import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import { z } from "zod";
import { formatZodError, apiError, apiSuccess } from "./errorHandler.js";

describe("formatZodError", () => {
  it("formats form-level errors", () => {
    const schema = z.string();
    const result = z.array(schema).safeParse([1, 2, 3]);
    assert.ok(!result.success);
    const { error, details } = formatZodError(result.error);
    assert.match(error, /expected string/i);
    assert.ok(typeof details === "object");
  });

  it("formats field-level errors", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = schema.safeParse({ name: 123, age: "old" });
    assert.ok(!result.success);
    const { error, details } = formatZodError(result.error);
    assert.match(error, /name/);
    assert.match(error, /age/);
    const d = details as { fieldErrors: Record<string, string[]>; formErrors: string[] };
    assert.ok(d.fieldErrors);
  });

  it("handles empty ZodError gracefully", () => {
    const schema = z.string();
    // Force a ZodError with no issues
    const zodErr = new ZodError([]);
    const { error } = formatZodError(zodErr);
    assert.equal(error, "Validation failed");
  });

  it("details include fieldErrors and formErrors", () => {
    const schema = z.object({ x: z.number() });
    const result = schema.safeParse({ x: "wrong" });
    assert.ok(!result.success);
    const { details } = formatZodError(result.error);
    const d = details as { fieldErrors: Record<string, string[]>; formErrors: string[] };
    assert.ok("fieldErrors" in d);
    assert.ok("formErrors" in d);
  });
});

describe("apiError", () => {
  function makeRes() {
    const res: { statusCode?: number; body?: unknown } = {};
    return {
      status(code: number) {
        res.statusCode = code;
        return { json(body: unknown) { res.body = body; return { statusCode: code, body }; } };
      },
    };
  }

  it("returns error JSON with status code", () => {
    const r = apiError(makeRes() as any, 400, "Bad request");
    assert.equal(r.statusCode, 400);
    assert.deepStrictEqual(r.body, { error: "Bad request", ok: false });
  });

  it("includes optional details", () => {
    const r = apiError(makeRes() as any, 422, "Validation", ["x is required"]);
    assert.equal(r.statusCode, 422);
    assert.deepStrictEqual(r.body, { error: "Validation", ok: false, details: ["x is required"] });
  });

  it("omits details when undefined", () => {
    const r = apiError(makeRes() as any, 500, "Server error");
    assert.ok(!("details" in r.body));
    assert.equal(r.body.error, "Server error");
  });
});

describe("apiSuccess", () => {
  function makeRes() {
    const res: { statusCode?: number; body?: unknown } = {};
    return {
      status(code: number) {
        res.statusCode = code;
        return { json(body: unknown) { res.body = body; return { statusCode: code, body }; } };
      },
    };
  }

  it("returns success JSON with default 200", () => {
    const r = apiSuccess(makeRes() as any, { items: [1, 2] });
    assert.equal(r.statusCode, 200);
    assert.deepStrictEqual(r.body, { data: { items: [1, 2] }, ok: true });
  });

  it("respects custom status code", () => {
    const r = apiSuccess(makeRes() as any, { id: "new" }, 201);
    assert.equal(r.statusCode, 201);
    assert.deepStrictEqual(r.body, { data: { id: "new" }, ok: true });
  });

  it("handles null data", () => {
    const r = apiSuccess(makeRes() as any, null);
    assert.equal(r.body.data, null);
    assert.ok(r.body.ok);
  });

  it("handles string data", () => {
    const r = apiSuccess(makeRes() as any, "ok");
    assert.equal(r.body.data, "ok");
    assert.ok(r.body.ok);
  });
});
