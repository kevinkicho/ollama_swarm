import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { securityHeaders } from "./securityHeaders.js";

function mockRes(): { headers: Record<string, string>; removed: string[]; setHeader(k: string, v: string): void; removeHeader(k: string): void } {
  const headers: Record<string, string> = {};
  const removed: string[] = [];
  return {
    headers,
    removed,
    setHeader(k: string, v: string) { headers[k] = v; },
    removeHeader(k: string) { removed.push(k); },
  };
}

describe("securityHeaders", () => {
  it("sets X-Content-Type-Options to nosniff", () => {
    const res = mockRes();
    let nextCalled = false;
    securityHeaders({} as any, res as any, () => { nextCalled = true; });
    assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(nextCalled, true);
  });

  it("sets X-Frame-Options to DENY", () => {
    const res = mockRes();
    securityHeaders({} as any, res as any, () => {});
    assert.equal(res.headers["X-Frame-Options"], "DENY");
  });

  it("sets X-XSS-Protection to 1; mode=block", () => {
    const res = mockRes();
    securityHeaders({} as any, res as any, () => {});
    assert.equal(res.headers["X-XSS-Protection"], "1; mode=block");
  });

  it("sets Referrer-Policy to strict-origin-when-cross-origin", () => {
    const res = mockRes();
    securityHeaders({} as any, res as any, () => {});
    assert.equal(res.headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  });

  it("removes X-Powered-By header", () => {
    const res = mockRes();
    securityHeaders({} as any, res as any, () => {});
    assert.ok(res.removed.includes("X-Powered-By"));
  });

  it("calls next()", () => {
    const res = mockRes();
    let called = false;
    securityHeaders({} as any, res as any, () => { called = true; });
    assert.equal(called, true);
  });
});