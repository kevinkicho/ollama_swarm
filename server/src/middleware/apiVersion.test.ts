import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apiVersion, API_VERSION } from "./apiVersion.js";

function mockRes(): { headers: Record<string, string>; nextCalled: boolean } {
  const out = { headers: {} as Record<string, string>, nextCalled: false };
  return out;
}

describe("apiVersion middleware", () => {
  it("sets X-API-Version header", () => {
    const headers: Record<string, string> = {};
    let nextCalled = false;
    const res = { setHeader(k: string, v: string) { headers[k] = v; } } as any;
    apiVersion({} as any, res, () => { nextCalled = true; });
    assert.equal(headers["X-API-Version"], API_VERSION);
    assert.ok(nextCalled);
  });

  it("calls next()", () => {
    let nextCalled = false;
    const res = { setHeader() {} } as any;
    apiVersion({} as any, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
  });

  it("exported version is a semver string", () => {
    assert.match(API_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it("header value matches exported constant", () => {
    const headers: Record<string, string> = {};
    apiVersion({} as any, { setHeader(k: string, v: string) { headers[k] = v; } } as any, () => {});
    assert.equal(headers["X-API-Version"], "1.0.0");
  });
});