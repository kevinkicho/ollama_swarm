import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requestLogger } from "./requestLogger.js";

function createMockReq(method: string, urlPath: string) {
  return { method, path: urlPath } as any;
}

function createMockRes(statusCode: number) {
  const callbacks: Record<string, (() => void)[]> = {};
  return {
    statusCode,
    setHeader(_name: string, _value: string) {
      // no-op for tests; middleware calls this for X-Request-Id
    },
    on(event: string, cb: () => void) {
      if (!callbacks[event]) callbacks[event] = [];
      callbacks[event].push(cb);
    },
    triggerFinish() {
      (callbacks["finish"] ?? []).forEach((cb) => cb());
    },
  } as any;
}

describe("requestLogger", () => {
  it("calls next() immediately", () => {
    let nextCalled = false;
    const req = createMockReq("GET", "/api/health");
    const res = createMockRes(200);
    requestLogger(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  function captureLogs(fn: () => void): string[] {
    const messages: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args: unknown[]) => { messages.push(args.join(" ")); };
    console.warn = (...args: unknown[]) => { messages.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { messages.push(args.join(" ")); };
    try {
      fn();
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    return messages;
  }

  it("logs INFO for 200 responses", () => {
    const req = createMockReq("GET", "/api/health");
    const res = createMockRes(200);
    const messages = captureLogs(() => {
      requestLogger(req, res, () => {});
      res.triggerFinish();
    });
    assert.ok(messages.some((m) => m.includes("[INFO]")), `expected [INFO] in log, got: ${messages.join("; ")}`);
    assert.ok(messages.some((m) => m.includes("GET")), "expected GET in log");
    assert.ok(messages.some((m) => m.includes("/api/health")), "expected /api/health in log");
    assert.ok(messages.some((m) => m.includes("200")), "expected 200 in log");
  });

  it("logs WARN for 4xx responses", () => {
    const req = createMockReq("POST", "/api/swarm/start");
    const res = createMockRes(429);
    const messages = captureLogs(() => {
      requestLogger(req, res, () => {});
      res.triggerFinish();
    });
    assert.ok(messages.some((m) => m.includes("[WARN]")), `expected [WARN] in log, got: ${messages.join("; ")}`);
    assert.ok(messages.some((m) => m.includes("429")), "expected 429 in log");
  });

  it("logs ERROR for 500 responses", () => {
    const req = createMockReq("GET", "/api/swarm/status");
    const res = createMockRes(500);
    const messages = captureLogs(() => {
      requestLogger(req, res, () => {});
      res.triggerFinish();
    });
    assert.ok(messages.some((m) => m.includes("[ERROR]")), `expected [ERROR] in log, got: ${messages.join("; ")}`);
    assert.ok(messages.some((m) => m.includes("500")), "expected 500 in log");
  });

  it("includes duration in ms", () => {
    const req = createMockReq("POST", "/api/swarm/say");
    const res = createMockRes(200);
    const messages = captureLogs(() => {
      requestLogger(req, res, () => {});
      res.triggerFinish();
    });
    assert.ok(messages.some((m) => m.includes("ms")), "expected duration in ms");
  });
});