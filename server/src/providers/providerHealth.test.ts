import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import {
  __resetProviderHealthForTests,
  getProvidersApiResponse,
  getProvidersStatusPayload,
  hasProviderKey,
  healthSummariesForProviders,
  probeProviders,
  probeWarningsForModels,
  uniqueProvidersForModels,
} from "./providerHealth.js";

beforeEach(() => {
  __resetProviderHealthForTests();
});

test("hasProviderKey — ollama always configured", () => {
  assert.equal(hasProviderKey("ollama"), true);
});

test("uniqueProvidersForModels — dedupes providers from model strings", () => {
  const providers = uniqueProvidersForModels([
    "llama3:8b",
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5",
    "anthropic/claude-opus-4-7",
  ]);
  assert.deepEqual(providers.sort(), ["anthropic", "ollama", "openai"]);
});

test("probeProviders — ollama ok populates cache", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "a" }, { name: "b" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  await probeProviders({ providers: ["ollama"], force: true, fetchImpl });
  const payload = getProvidersStatusPayload();
  assert.equal(payload.providers.ollama.probeStatus, "ok");
  assert.equal(payload.providers.ollama.modelCount, 2);
  assert.equal(payload.providers.ollama.source, "live");
});

test("probeProviders — ollama down on fetch failure", async () => {
  const fetchImpl = (async () => {
    throw new Error("connection refused");
  }) as typeof fetch;

  await probeProviders({ providers: ["ollama"], force: true, fetchImpl });
  const rec = getProvidersStatusPayload().providers.ollama;
  assert.equal(rec.probeStatus, "down");
  assert.ok(rec.lastError);
});

test("probeProviders — anthropic unconfigured without key", async (t) => {
  if (config.ANTHROPIC_API_KEY) {
    return t.skip("ANTHROPIC_API_KEY is set in this environment");
  }
  await probeProviders({ providers: ["anthropic"], force: true, fetchImpl: fetch });
  const rec = getProvidersStatusPayload().providers.anthropic;
  assert.equal(rec.probeStatus, "unconfigured");
  assert.equal(rec.hasKey, false);
});

test("probeProviders — opencode ok via models discovery", async () => {
  const fetchImpl = (async (url: string) => {
    if (url === "https://opencode.ai/zen/go/v1/models") {
      return new Response(JSON.stringify({ data: [{ id: "glm-5.1" }, { id: "deepseek-v4-flash" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  await probeProviders({ providers: ["opencode"], force: true, fetchImpl });
  const rec = getProvidersStatusPayload().providers.opencode;
  assert.equal(rec.probeStatus, "ok");
  assert.equal(rec.modelCount, 2);
});

test("probeProviders — opencode rate limit surfaces as rate_limited", async (t) => {
  if (!hasProviderKey("opencode")) {
    return t.skip("no OpenCode API key in this environment");
  }
  const fetchImpl = (async (url: string) => {
    if (url.includes("opencode.ai")) {
      return new Response("too many", { status: 429 });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  await probeProviders({ providers: ["opencode"], force: true, fetchImpl });
  const rec = getProvidersStatusPayload().providers.opencode;
  assert.equal(rec.probeStatus, "rate_limited");
});

test("getProvidersApiResponse — includes health + runtime per provider", () => {
  const body = getProvidersApiResponse();
  assert.ok(body.gateway);
  assert.ok(body.meta);
  assert.ok(body.ollama);
  const ollama = body.ollama as { health: { probeStatus: string }; runtime: { circuit: string } };
  assert.ok(ollama.health.probeStatus);
  assert.ok(ollama.runtime.circuit);
});

test("probeWarningsForModels — warns when cached provider is down", async () => {
  const fetchImpl = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  await probeProviders({ providers: ["ollama"], force: true, fetchImpl });

  const warnings = probeWarningsForModels(["llama3:8b"]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].provider, "ollama");
  assert.equal(warnings[0].probeStatus, "down");
});

test("healthSummariesForProviders — returns partial map for requested providers", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "x" }] }), { status: 200 });
    }
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  await probeProviders({ providers: ["ollama"], force: true, fetchImpl });

  const summaries = healthSummariesForProviders(["ollama"]);
  assert.equal(summaries.ollama?.probeStatus, "ok");
  assert.equal(summaries.anthropic, undefined);
});