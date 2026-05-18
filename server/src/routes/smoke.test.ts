// Cross-layer smoke test: verifies the form→server→runner contract.
// Starts the server, POSTs /api/swarm/start, and checks that:
//   1. run_started.plannerModel matches the user's model
//   2. The topology planner model is not overridden by defaults
//   3. No failover events fire in the initial run phases
//
// Run from server/:
//   npx tsx --test src/routes/smoke.test.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";

const SERVER_PORT = 19876;
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;
const TEST_PASSWORD = "smoke-test-password";

let serverProcess: ChildProcess | null = null;

async function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(
      process.execPath,
      ["--import", "tsx", "src/index.ts"],
      {
        env: {
          ...process.env,
          SERVER_PORT: String(SERVER_PORT),
          OPENCODE_SERVER_PASSWORD: TEST_PASSWORD,
          OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
          OLLAMA_PROXY_PORT: "0", // disable proxy for smoke tests
          OPENCODE_API_KEY: process.env.OPENCODE_API_KEY ?? "",
          SKIP_WSL_CHECK: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    serverProcess.on("error", reject);

    const timeout = setTimeout(() => {
      reject(new Error("Server failed to start within 10 seconds"));
    }, 10_000);

    serverProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.includes("listening on")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

function stopServer(): void {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

// TODO: These tests require the server to start and listen, which takes
// ~5-10 seconds. They will be run with --test-concurrency=1.
// For now we verify the model resolution pipeline statically.
// The full integration test requires a running server and valid API keys.

describe("Cross-layer smoke — static contract", () => {
  afterEach(stopServer);

  it("verifies that resolveModels correctly preserves user model for blackboard", async () => {
    // Dynamic import to avoid esbuild transform issues
    const { resolveModels } = await import("../../../shared/src/modelConfig.js");

    const defaults = {
      model: "glm-5.1:cloud",
      workerModel: "gemma4:31b-cloud",
      auditorModel: "nemotron-3-super:cloud",
      dedicatedAuditor: true,
    };

    // User selects opencode-go/deepseek-v4-pro in the top-level model field.
    // No Advanced section fields are set. No topology override.
    // Expected: plannerModel should be opencode-go/deepseek-v4-pro
    const result = resolveModels(
      {
        model: "opencode-go/deepseek-v4-pro",
        preset: "blackboard",
      },
      defaults,
    );

    assert.equal(result.model, "opencode-go/deepseek-v4-pro");
    assert.equal(result.plannerModel, "opencode-go/deepseek-v4-pro",
      "Planner model must match user's model when no explicit override set");
    assert.equal(result.workerModel, "gemma4:31b-cloud",
      "Worker model should use the default");
    assert.equal(result.auditorModel, "nemotron-3-super:cloud",
      "Auditor model should use the default");
  });

  it("verifies resolveModels for blackboard with explicit plannerModel", async () => {
    const { resolveModels } = await import("../../../shared/src/modelConfig.js");

    const defaults = {
      model: "glm-5.1:cloud",
      workerModel: "gemma4:31b-cloud",
      auditorModel: "nemotron-3-super:cloud",
      dedicatedAuditor: true,
    };

    // Advanced section explicitly sets plannerModel to opencode-go/deepseek-v4-pro
    const result = resolveModels(
      {
        model: "gemma4:31b-cloud",
        plannerModel: "opencode-go/deepseek-v4-pro",
        preset: "blackboard",
      },
      defaults,
    );

    assert.equal(result.plannerModel, "opencode-go/deepseek-v4-pro",
      "Explicit plannerModel must win over model");
  });

  it("verifies topology does NOT override explicit plannerModel", async () => {
    const { resolveModels } = await import("../../../shared/src/modelConfig.js");

    const defaults = {
      model: "glm-5.1:cloud",
      workerModel: "gemma4:31b-cloud",
      auditorModel: "nemotron-3-super:cloud",
      dedicatedAuditor: true,
    };

    // Topology has stale glm-5.1:cloud for planner, but user explicitly
    // selected opencode-go/deepseek-v4-pro as plannerModel.
    const result = resolveModels(
      {
        model: "gemma4:31b-cloud",
        plannerModel: "opencode-go/deepseek-v4-pro",
        preset: "blackboard",
        topology: {
          agents: [
            { index: 1, role: "planner", removable: false, model: "glm-5.1:cloud" },
            { index: 2, role: "worker", removable: true },
            { index: 3, role: "worker", removable: true },
            { index: 4, role: "auditor", removable: false, model: "nemotron-3-super:cloud" },
          ],
        },
      },
      defaults,
    );

    assert.equal(result.plannerModel, "opencode-go/deepseek-v4-pro",
      "Explicit plannerModel MUST win over topology override — this was a critical bug");
  });

  it("verifies non-blackboard presets share model across all roles", async () => {
    const { resolveModels } = await import("../../../shared/src/modelConfig.js");

    const defaults = {
      model: "glm-5.1:cloud",
      workerModel: "gemma4:31b-cloud",
      auditorModel: "nemotron-3-super:cloud",
      dedicatedAuditor: true,
    };

    const presets = ["round-robin", "council", "debate-judge", "map-reduce", "stigmergy", "moa"];
    for (const preset of presets) {
      const result = resolveModels(
        { model: "opencode-go/glm-5.1", preset },
        defaults,
      );
      assert.equal(result.model, "opencode-go/glm-5.1");
      assert.equal(result.plannerModel, "opencode-go/glm-5.1",
        `Planner should use model for ${preset}`);
      assert.equal(result.workerModel, "opencode-go/glm-5.1",
        `Worker should use model for ${preset}`);
      assert.equal(result.auditorModel, "opencode-go/glm-5.1",
        `Auditor should use model for ${preset}`);
    }
  });

  it("verifies empty model falls through to config defaults", async () => {
    const { resolveModels } = await import("../../../shared/src/modelConfig.js");

    const defaults = {
      model: "glm-5.1:cloud",
      workerModel: "gemma4:31b-cloud",
      auditorModel: "nemotron-3-super:cloud",
      dedicatedAuditor: true,
    };

    const result = resolveModels(
      { preset: "blackboard" },
      defaults,
    );

    assert.equal(result.model, "glm-5.1:cloud");
    assert.equal(result.plannerModel, "glm-5.1:cloud");
    assert.equal(result.workerModel, "gemma4:31b-cloud");
    assert.equal(result.auditorModel, "nemotron-3-super:cloud");
  });
});
