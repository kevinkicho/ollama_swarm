import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkDockerAvailable,
  executeInContainer,
  runSweBenchVerify,
} from "./dockerExecutor.mjs";

// All tests use a mocked dockerSpawn — no actual docker needed.
// The mock receives the args array + returns a canned result.

function mockSpawn(handler) {
  return async (args, opts) => handler(args, opts);
}

// ---------------------------------------------------------------------------
// checkDockerAvailable
// ---------------------------------------------------------------------------

test("checkDockerAvailable — returns ok with version when docker version succeeds", async () => {
  const dockerSpawn = mockSpawn(async (args) => {
    assert.deepEqual(args, ["version", "--format", "{{.Server.Version}}"]);
    return { stdout: "24.0.5\n", stderr: "", exitCode: 0 };
  });
  const result = await checkDockerAvailable({ dockerSpawn });
  assert.equal(result.ok, true);
  assert.equal(result.version, "24.0.5");
});

test("checkDockerAvailable — returns ok=false when docker CLI not found (exitCode 127)", async () => {
  const dockerSpawn = mockSpawn(async () => ({
    stdout: "",
    stderr: "spawn docker ENOENT",
    exitCode: 127,
  }));
  const result = await checkDockerAvailable({ dockerSpawn });
  assert.equal(result.ok, false);
  assert.match(result.reason, /docker CLI not found/);
});

test("checkDockerAvailable — returns ok=false when docker daemon unreachable", async () => {
  const dockerSpawn = mockSpawn(async () => ({
    stdout: "",
    stderr: "Cannot connect to the Docker daemon",
    exitCode: 1,
  }));
  const result = await checkDockerAvailable({ dockerSpawn });
  assert.equal(result.ok, false);
  assert.match(result.reason, /docker version exited 1/);
});

// ---------------------------------------------------------------------------
// executeInContainer
// ---------------------------------------------------------------------------

test("executeInContainer — builds correct docker run args with all flags", async () => {
  let observedArgs = null;
  const dockerSpawn = mockSpawn(async (args) => {
    if (args[0] === "version") return { stdout: "24.0.5\n", stderr: "", exitCode: 0 };
    observedArgs = args;
    return { stdout: "test passed\n", stderr: "", exitCode: 0 };
  });
  await executeInContainer(
    {
      image: "swebench/test:latest",
      repoPath: "/host/repo",
      command: "pytest test_x.py",
    },
    { dockerSpawn },
  );
  assert.ok(observedArgs);
  assert.equal(observedArgs[0], "run");
  assert.ok(observedArgs.includes("--rm"));
  assert.ok(observedArgs.includes("--network"));
  assert.ok(observedArgs.includes("none"));
  // Check bind mount target
  const vIdx = observedArgs.indexOf("-v");
  assert.ok(vIdx >= 0);
  assert.equal(observedArgs[vIdx + 1], "/host/repo:/workspace");
  // Check workdir
  const wIdx = observedArgs.indexOf("-w");
  assert.equal(observedArgs[wIdx + 1], "/workspace");
  // Check image + command
  assert.ok(observedArgs.includes("swebench/test:latest"));
  assert.ok(observedArgs.includes("sh"));
  assert.ok(observedArgs.includes("pytest test_x.py"));
});

test("executeInContainer — returns dockerAvailable=false when docker not on PATH", async () => {
  const dockerSpawn = mockSpawn(async (args) => {
    if (args[0] === "version") return { stdout: "", stderr: "ENOENT", exitCode: 127 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  const result = await executeInContainer(
    { image: "x", repoPath: "/p", command: "cmd" },
    { dockerSpawn },
  );
  assert.equal(result.dockerAvailable, false);
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /docker not available/);
});

test("executeInContainer — propagates exitCode + stdout + stderr from container", async () => {
  const dockerSpawn = mockSpawn(async (args) => {
    if (args[0] === "version") return { stdout: "24\n", stderr: "", exitCode: 0 };
    return { stdout: "test output\n", stderr: "warning\n", exitCode: 42 };
  });
  const result = await executeInContainer(
    { image: "x", repoPath: "/p", command: "cmd" },
    { dockerSpawn },
  );
  assert.equal(result.exitCode, 42);
  assert.equal(result.stdout, "test output\n");
  assert.equal(result.stderr, "warning\n");
  assert.equal(result.dockerAvailable, true);
});

test("executeInContainer — timeout fires when run takes too long", async () => {
  const dockerSpawn = mockSpawn(async (args) => {
    if (args[0] === "version") return { stdout: "24\n", stderr: "", exitCode: 0 };
    // Simulate a long-running container
    await new Promise((r) => setTimeout(r, 5000));
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  const result = await executeInContainer(
    { image: "x", repoPath: "/p", command: "cmd", timeoutMs: 100 },
    { dockerSpawn },
  );
  assert.equal(result.exitCode, -2);
  assert.match(result.stderr, /timeout after 100ms/);
});

test("executeInContainer — throws on missing required inputs", async () => {
  await assert.rejects(
    () => executeInContainer({ repoPath: "/p", command: "c" }, { dockerSpawn: mockSpawn(() => ({})) }),
    /image \(string\) is required/,
  );
  await assert.rejects(
    () => executeInContainer({ image: "x", command: "c" }, { dockerSpawn: mockSpawn(() => ({})) }),
    /repoPath \(string\) is required/,
  );
  await assert.rejects(
    () => executeInContainer({ image: "x", repoPath: "/p" }, { dockerSpawn: mockSpawn(() => ({})) }),
    /command \(string\) is required/,
  );
});

// ---------------------------------------------------------------------------
// runSweBenchVerify
// ---------------------------------------------------------------------------

test("runSweBenchVerify — pass=true when container exits 0 with test_patch applied", async () => {
  let receivedCommand = "";
  const dockerSpawn = mockSpawn(async (args) => {
    if (args[0] === "version") return { stdout: "24\n", stderr: "", exitCode: 0 };
    receivedCommand = args[args.length - 1];
    return { stdout: "1 passed\n", stderr: "", exitCode: 0 };
  });
  const result = await runSweBenchVerify(
    {
      image: "swebench/test:latest",
      repoPath: "/host/repo",
      testPatch: "diff --git a/x b/x\n+changed",
      testCommand: "pytest -k test_y",
    },
    { dockerSpawn },
  );
  assert.equal(result.pass, true);
  assert.equal(result.reason, "tests-passed");
  // Patch must be base64-encoded into the command
  assert.match(receivedCommand, /base64 -d \| git apply/);
  assert.match(receivedCommand, /pytest -k test_y/);
});

test("runSweBenchVerify — pass=false reason=tests-failed when container exits non-zero", async () => {
  const dockerSpawn = mockSpawn(async (args) => {
    if (args[0] === "version") return { stdout: "24\n", stderr: "", exitCode: 0 };
    return { stdout: "1 failed\n", stderr: "", exitCode: 1 };
  });
  const result = await runSweBenchVerify(
    { image: "x", repoPath: "/p", testPatch: "diff", testCommand: "pytest" },
    { dockerSpawn },
  );
  assert.equal(result.pass, false);
  assert.equal(result.reason, "tests-failed");
});

test("runSweBenchVerify — reason=patch-conflict when git apply fails", async () => {
  const dockerSpawn = mockSpawn(async (args) => {
    if (args[0] === "version") return { stdout: "24\n", stderr: "", exitCode: 0 };
    return {
      stdout: "",
      stderr: "error: patch failed: src/x.py:42",
      exitCode: 1,
    };
  });
  const result = await runSweBenchVerify(
    { image: "x", repoPath: "/p", testPatch: "diff", testCommand: "pytest" },
    { dockerSpawn },
  );
  assert.equal(result.pass, false);
  assert.equal(result.reason, "patch-conflict");
});

test("runSweBenchVerify — reason=docker-unavailable when docker missing", async () => {
  const dockerSpawn = mockSpawn(async () => ({
    stdout: "",
    stderr: "ENOENT",
    exitCode: 127,
  }));
  const result = await runSweBenchVerify(
    { image: "x", repoPath: "/p", testPatch: "", testCommand: "pytest" },
    { dockerSpawn },
  );
  assert.equal(result.pass, false);
  assert.equal(result.reason, "docker-unavailable");
});

test("runSweBenchVerify — empty test_patch skips git apply, runs command directly", async () => {
  let receivedCommand = "";
  const dockerSpawn = mockSpawn(async (args) => {
    if (args[0] === "version") return { stdout: "24\n", stderr: "", exitCode: 0 };
    receivedCommand = args[args.length - 1];
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  await runSweBenchVerify(
    { image: "x", repoPath: "/p", testPatch: "", testCommand: "pytest -k smoke" },
    { dockerSpawn },
  );
  assert.equal(receivedCommand, "pytest -k smoke");
  assert.doesNotMatch(receivedCommand, /git apply/);
});
