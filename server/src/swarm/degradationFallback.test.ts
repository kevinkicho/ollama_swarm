// R3 (2026-05-04): tests for cloud → local degradation fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCloudModel,
  pickLocalFallback,
  inferParamSize,
} from "./degradationFallback.js";

test("isCloudModel — anthropic prefix → cloud", () => {
  assert.equal(isCloudModel("anthropic/claude-opus-4-7"), true);
});

test("isCloudModel — openai prefix → cloud", () => {
  assert.equal(isCloudModel("openai/gpt-5"), true);
});

test("isCloudModel — :cloud suffix → cloud", () => {
  assert.equal(isCloudModel("glm-5.1:cloud"), true);
});

test("isCloudModel — bare local tag → not cloud", () => {
  assert.equal(isCloudModel("llama3:8b"), false);
  assert.equal(isCloudModel("mistral"), false);
});

test("inferParamSize — N b suffix", () => {
  assert.equal(inferParamSize("llama3:8b"), 8);
  assert.equal(inferParamSize("qwen2.5:14b"), 14);
});

test("inferParamSize — decimal", () => {
  assert.equal(inferParamSize("phi3:3.8b"), 3.8);
});

test("inferParamSize — millions normalized to billions", () => {
  // 700m → 0.7b
  assert.equal(inferParamSize("ministral:700m"), 0.7);
});

test("inferParamSize — no size info → 0", () => {
  assert.equal(inferParamSize("phi3"), 0);
});

test("pickLocalFallback — empty local tags → null", () => {
  const got = pickLocalFallback({
    failedModel: "anthropic/claude-opus-4-7",
    localTags: [],
  });
  assert.equal(got, null);
});

test("pickLocalFallback — preferred match wins over size", () => {
  const got = pickLocalFallback({
    failedModel: "anthropic/claude-opus-4-7",
    localTags: ["llama3:8b", "qwen2.5:14b", "mistral:7b"],
    preferred: ["mistral:7b"],
  });
  assert.equal(got, "mistral:7b");
});

test("pickLocalFallback — preferred list first match wins", () => {
  const got = pickLocalFallback({
    failedModel: "anthropic/claude-opus-4-7",
    localTags: ["llama3:8b", "qwen2.5:14b"],
    preferred: ["mistral:7b", "qwen2.5:14b", "llama3:8b"],
  });
  // mistral isn't pulled, so qwen wins as the first preferred that IS available
  assert.equal(got, "qwen2.5:14b");
});

test("pickLocalFallback — falls back to largest model by param count", () => {
  const got = pickLocalFallback({
    failedModel: "anthropic/claude-opus-4-7",
    localTags: ["llama3:8b", "qwen2.5:14b", "phi3:3.8b"],
  });
  assert.equal(got, "qwen2.5:14b");
});

test("pickLocalFallback — excludes failed model from candidates", () => {
  const got = pickLocalFallback({
    failedModel: "llama3:8b",
    localTags: ["llama3:8b"],
  });
  assert.equal(got, null);
});

test("pickLocalFallback — single local tag → that tag", () => {
  const got = pickLocalFallback({
    failedModel: "anthropic/claude-opus-4-7",
    localTags: ["llama3:8b"],
  });
  assert.equal(got, "llama3:8b");
});

test("pickLocalFallback — ties broken alphabetically (deterministic)", () => {
  const got = pickLocalFallback({
    failedModel: "anthropic/claude-opus-4-7",
    localTags: ["mistral:7b", "qwen:7b", "llama:7b"],
  });
  // All three are 7b; alphabetical → llama wins
  assert.equal(got, "llama:7b");
});
