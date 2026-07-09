import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { submitMidRunNudge } from "./submitMidRunNudge.js";

function mockFetch(handlers: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>>) {
  return (async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected fetch: ${path}`);
    return handler(path, init);
  }) as typeof fetch;
}

describe("submitMidRunNudge", () => {
  it("resolves active runId from /api/swarm/status before POSTing amend", async () => {
    const calls: string[] = [];
    const fetchImpl = mockFetch({
      "/api/swarm/status": () => {
        calls.push("status");
        return new Response(JSON.stringify({ runId: "active-run-99" }), { status: 200 });
      },
      "/api/swarm/amend": (_path, init) => {
        calls.push("amend");
        const body = JSON.parse(String(init?.body)) as { runId: string; text: string };
        assert.equal(body.runId, "active-run-99");
        assert.equal(body.text, "focus on auth");
        return new Response(
          JSON.stringify({ ok: true, amendment: { ts: 1000, text: "focus on auth" } }),
          { status: 200 },
        );
      },
    });

    const result = await submitMidRunNudge("  focus on auth  ", fetchImpl);
    assert.deepEqual(calls, ["status", "amend"]);
    assert.equal(result.activeRunId, "active-run-99");
    assert.equal(result.amendment.text, "focus on auth");
  });

  it("throws when server has no active run", async () => {
    const fetchImpl = mockFetch({
      "/api/swarm/status": () => new Response(JSON.stringify({}), { status: 200 }),
    });
    await assert.rejects(() => submitMidRunNudge("hello", fetchImpl), /No active run/);
  });

  it("surfaces amend 404 as an error", async () => {
    const fetchImpl = mockFetch({
      "/api/swarm/status": () =>
        new Response(JSON.stringify({ runId: "gone" }), { status: 200 }),
      "/api/swarm/amend": () =>
        new Response(JSON.stringify({ error: "No active run with that runId, or text was empty" }), {
          status: 404,
        }),
    });
    await assert.rejects(
      () => submitMidRunNudge("hello", fetchImpl),
      /No active run with that runId/,
    );
  });
});