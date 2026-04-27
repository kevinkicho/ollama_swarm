// 2026-04-27 tests: SSE-aware turn watchdog. Verifies that the
// watchdog only aborts when SSE has truly been silent for the
// configured idle threshold AND wall-clock has passed it — and that
// the hard wall-clock ceiling fires regardless of SSE activity.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  startSseAwareTurnWatchdog,
  type SseAwareTurnWatchdogOpts,
} from "./sseAwareTurnWatchdog.js";

interface FakeManager {
  getLastActivity: (sid: string) => number | undefined;
  touchActivity: (sid: string, ts?: number) => void;
}

function makeFakeManager(initial?: number): FakeManager {
  let last = initial;
  return {
    getLastActivity: () => last,
    touchActivity: (_sid, ts = Date.now()) => {
      last = ts;
    },
  };
}

function harness(overrides: Partial<SseAwareTurnWatchdogOpts> = {}): {
  controller: AbortController;
  abortCalls: number;
  watchdog: ReturnType<typeof startSseAwareTurnWatchdog>;
  fakeMgr: FakeManager;
} {
  const fakeMgr = makeFakeManager();
  let abortCalls = 0;
  const controller = new AbortController();
  const watchdog = startSseAwareTurnWatchdog({
    manager: fakeMgr as unknown as SseAwareTurnWatchdogOpts["manager"],
    sessionId: "ses_test",
    controller,
    abortSession: async () => {
      abortCalls += 1;
    },
    sseIdleCapMs: 100,
    hardMaxMs: 1000,
    pollIntervalMs: 30,
    ...overrides,
  });
  return { controller, abortCalls: 0 as number, watchdog, fakeMgr };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startSseAwareTurnWatchdog", () => {
  it("aborts when SSE idle exceeds cap AND elapsed exceeds cap", async () => {
    const { controller, watchdog } = harness({ sseIdleCapMs: 100, hardMaxMs: 5000 });
    // Don't touchActivity — let it stay at turnStart so SSE-idle grows
    await sleep(200);
    watchdog.cancel();
    assert.equal(controller.signal.aborted, true);
    assert.match(watchdog.getAbortReason() ?? "", /SSE idle/);
  });

  it("does NOT abort when SSE keeps touching activity", async () => {
    const fakeMgr = makeFakeManager();
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: fakeMgr as unknown as SseAwareTurnWatchdogOpts["manager"],
      sessionId: "ses_test",
      controller,
      abortSession: async () => {},
      sseIdleCapMs: 100,
      hardMaxMs: 5000,
      pollIntervalMs: 30,
    });
    // Touch every 50ms — well within the 100ms cap
    const ticker = setInterval(() => fakeMgr.touchActivity("ses_test"), 50);
    await sleep(300);
    clearInterval(ticker);
    watchdog.cancel();
    assert.equal(controller.signal.aborted, false);
    assert.equal(watchdog.getAbortReason(), null);
  });

  it("hard wall-clock ceiling fires even if SSE keeps flowing", async () => {
    const fakeMgr = makeFakeManager();
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: fakeMgr as unknown as SseAwareTurnWatchdogOpts["manager"],
      sessionId: "ses_test",
      controller,
      abortSession: async () => {},
      sseIdleCapMs: 5000,
      hardMaxMs: 200,
      pollIntervalMs: 30,
    });
    // Keep SSE alive — but hard cap should still fire
    const ticker = setInterval(() => fakeMgr.touchActivity("ses_test"), 30);
    await sleep(350);
    clearInterval(ticker);
    watchdog.cancel();
    assert.equal(controller.signal.aborted, true);
    assert.match(watchdog.getAbortReason() ?? "", /hard wall-clock/);
  });

  it("calls abortSession callback exactly once on abort", async () => {
    const fakeMgr = makeFakeManager();
    const controller = new AbortController();
    let abortCalls = 0;
    const watchdog = startSseAwareTurnWatchdog({
      manager: fakeMgr as unknown as SseAwareTurnWatchdogOpts["manager"],
      sessionId: "ses_test",
      controller,
      abortSession: async () => {
        abortCalls += 1;
      },
      sseIdleCapMs: 80,
      hardMaxMs: 5000,
      pollIntervalMs: 20,
    });
    await sleep(250);
    watchdog.cancel();
    assert.equal(abortCalls, 1);
  });

  it("cancel before abort prevents future trips", async () => {
    const { controller, watchdog } = harness({ sseIdleCapMs: 100, hardMaxMs: 5000 });
    await sleep(50);
    watchdog.cancel();
    await sleep(200);
    assert.equal(controller.signal.aborted, false);
  });

  it("getAbortReason returns null until abort fires", () => {
    const { watchdog } = harness();
    assert.equal(watchdog.getAbortReason(), null);
    watchdog.cancel();
  });
});
