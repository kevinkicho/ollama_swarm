import { test } from "node:test";
import assert from "node:assert/strict";
import { missingProviderKeysForModels } from "./providerKeyCheck.js";
import { config } from "../config.js";

test("missingProviderKeysForModels — ollama models produce no warnings", () => {
  const w = missingProviderKeysForModels(["deepseek-v4-flash:cloud", "llama3:8b"]);
  assert.equal(w.length, 0);
});

test("missingProviderKeysForModels — anthropic reflects server key state", () => {
  const w = missingProviderKeysForModels(["anthropic/claude-sonnet-4-6"]);
  if (config.ANTHROPIC_API_KEY) {
    assert.equal(w.length, 0);
  } else {
    assert.equal(w.length, 1);
    assert.equal(w[0].provider, "anthropic");
    assert.match(w[0].message, /ANTHROPIC_API_KEY/);
  }
});