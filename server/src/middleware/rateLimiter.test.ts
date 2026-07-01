import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "./rateLimiter.js";

function mockReq(ip?: string) {
  return { ip: ip ?? "127.0.0.1" } as any;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = (name: string, value: string) => {
    res.headers[name.toLowerCase()] = value;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

describe("rateLimit", () => {
  it("allows requests within limit", () => {
    const limiter = rateLimit({ windowMs: 60000, max: 3 });
    for (let i = 0; i < 3; i++) {
      const req = mockReq();
      const res = mockRes();
      let nextCalled = false;
      limiter(req, res, () => { nextCalled = true; });
      assert.ok(nextCalled, `request ${i + 1} should call next`);
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers["x-ratelimit-remaining"], "should set rate-limit headers");
    }
  });

  it("blocks requests exceeding limit", () => {
    const limiter = rateLimit({ windowMs: 60000, max: 2 });
    const res = mockRes();
    let nextCalled = false;

    limiter(mockReq(), mockRes(), () => {}); // 1
    limiter(mockReq(), mockRes(), () => {}); // 2
    limiter(mockReq(), res, () => { nextCalled = true; }); // 3 (blocked)

    assert.ok(!nextCalled, "should not call next when over limit");
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error, "Too many requests — rate limit exceeded");
    assert.equal(res.body.ok, false);
  });

  it("sets ratelimit headers correctly", () => {
    const limiter = rateLimit({ windowMs: 30000, max: 10 });
    const req = mockReq();
    const res = mockRes();
    limiter(req, res, () => {});

    assert.equal(res.headers["x-ratelimit-limit"], "10");
    assert.equal(res.headers["x-ratelimit-remaining"], "9");
    assert.ok(res.headers["x-ratelimit-reset"], "should set reset timestamp");
  });

  it("counts remaining decreases with each request", () => {
    const limiter = rateLimit({ windowMs: 60000, max: 5 });
    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      limiter(mockReq(), res, () => {});
      assert.equal(res.headers["x-ratelimit-remaining"], String(5 - i - 1));
    }
  });

  it("uses custom keyFn for rate-limit key", () => {
    let lastKey = "";
    const limiter = rateLimit({
      windowMs: 60000,
      max: 2,
      keyFn: (req) => {
        lastKey = req.headers?.["x-user-id"] ?? "anon";
        return lastKey;
      },
    });
    const req1 = { headers: { "x-user-id": "user-a" } } as any;
    const req2 = { headers: { "x-user-id": "user-b" } } as any;

    let nextCalled = false;
    limiter(req1, mockRes(), () => {}); // user-a: 1
    limiter(req1, mockRes(), () => {}); // user-a: 2
    limiter(req1, mockRes(), () => { nextCalled = true; }); // user-a: 3 (should be blocked)
    assert.ok(!nextCalled, "user-a should be blocked");

    // user-b should NOT be blocked (different key)
    nextCalled = false;
    limiter(req2, mockRes(), () => { nextCalled = true; });
    assert.ok(nextCalled, "user-b should still be allowed");
  });

  it("uses IP as default key", () => {
    const limiter = rateLimit({ windowMs: 60000, max: 1 });
    const res = mockRes();
    let nextCalled = false;
    limiter(mockReq("1.2.3.4"), mockRes(), () => {});
    limiter(mockReq("1.2.3.4"), res, () => { nextCalled = true; });
    assert.ok(!nextCalled, "same IP should be blocked");
  });

  it("uses 'unknown' when IP is missing", () => {
    const limiter = rateLimit({ windowMs: 60000, max: 1 });
    let nextCalled = false;
    limiter({ ip: undefined } as any, mockRes(), () => {});
    limiter({ ip: undefined } as any, mockRes(), () => { nextCalled = true; });
    assert.ok(!nextCalled, "unknown-key requests should be rate limited together");
  });

  it("remaining never goes below zero in headers", () => {
    const limiter = rateLimit({ windowMs: 60000, max: 1 });
    limiter(mockReq(), mockRes(), () => {}); // 0 remaining
    const res = mockRes();
    limiter(mockReq(), res, () => {}); // -1 remaining, blocked
    assert.equal(res.headers["x-ratelimit-remaining"], "0");
  });

  it("reset time is in seconds (unix timestamp)", () => {
    const limiter = rateLimit({ windowMs: 60000, max: 1 });
    const res = mockRes();
    limiter(mockReq(), res, () => {});
    const resetSec = Number(res.headers["x-ratelimit-reset"]);
    const nowSec = Math.ceil(Date.now() / 1000);
    assert.ok(resetSec >= nowSec, "reset should be in the future");
    assert.ok(resetSec <= nowSec + 120, "reset should be within ~2 minutes");
  });
});
