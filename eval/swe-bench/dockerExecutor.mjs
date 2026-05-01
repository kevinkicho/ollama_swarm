// #100 (2026-05-01): Docker-based test execution for SWE-Bench tasks.
//
// SWE-Bench tasks reference real Python repos with native deps (numpy /
// scipy / etc.) that won't install in our local Node-only env. The
// official SWE-Bench harness uses per-task Docker images with all deps
// preinstalled. This module is the integration layer.
//
// Design:
//   - executeInContainer({ image, repoPath, command, timeoutMs }) →
//     { exitCode, stdout, stderr, durationMs, dockerAvailable }
//   - Dependency-injected `dockerSpawn` so tests can mock the docker
//     subprocess. Production callers pass the default which uses
//     node:child_process.spawn with the docker CLI.
//   - `checkDockerAvailable()` runs `docker version` and returns boolean.
//     Used by the eval harness to decide whether to attempt the task or
//     skip with "docker not available."
//
// This module is intentionally minimal — it does NOT pull images,
// build them, or manage layers. Caller is expected to have the image
// already pulled (`docker pull <image>`). The eval harness's setup
// step handles that orchestration.

import { spawn } from "node:child_process";

/**
 * @typedef {Object} ExecResult
 * @property {number} exitCode
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} durationMs
 * @property {boolean} dockerAvailable  false when docker CLI not on PATH
 */

/** Default docker spawn — wraps node:child_process.spawn. Returns
 *  Promise<{stdout, stderr, exitCode}>. Used by production callers;
 *  tests pass a mock. */
export function defaultDockerSpawn(args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn("docker", args, { ...opts });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => {
      // docker CLI not found / permission denied / etc.
      resolve({ stdout, stderr: stderr + String(err.message), exitCode: 127 });
    });
    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

/**
 * Check whether the docker CLI is available + responsive.
 * @param {{ dockerSpawn?: typeof defaultDockerSpawn }} [opts]
 * @returns {Promise<{ ok: boolean; reason?: string; version?: string }>}
 */
export async function checkDockerAvailable(opts = {}) {
  const dockerSpawn = opts.dockerSpawn ?? defaultDockerSpawn;
  const result = await dockerSpawn(["version", "--format", "{{.Server.Version}}"]);
  if (result.exitCode === 127) {
    return { ok: false, reason: "docker CLI not found on PATH" };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `docker version exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
    };
  }
  const version = result.stdout.trim();
  return { ok: true, version };
}

/**
 * Run a command inside a Docker container with the repo mounted at /workspace.
 * Caller is responsible for ensuring the image is pulled.
 *
 * @param {Object} input
 * @param {string} input.image           Docker image, e.g. "swebench/sweb.eval.x86_64.astropy_1776:latest"
 * @param {string} input.repoPath        Absolute path on the host to mount at /workspace
 * @param {string} input.command         Shell command to run inside the container
 * @param {number} [input.timeoutMs]     Hard timeout (default 600_000 = 10min)
 * @param {string} [input.workdir]       Working directory inside the container (default "/workspace")
 * @param {Object} [opts]
 * @param {typeof defaultDockerSpawn} [opts.dockerSpawn]
 * @returns {Promise<ExecResult>}
 */
export async function executeInContainer(input, opts = {}) {
  const t0 = Date.now();
  const dockerSpawn = opts.dockerSpawn ?? defaultDockerSpawn;
  const timeoutMs = input.timeoutMs ?? 600_000;
  const workdir = input.workdir ?? "/workspace";

  // Validate inputs early — fail fast with a clear message rather than
  // a confusing docker error.
  if (!input.image || typeof input.image !== "string") {
    throw new Error("executeInContainer: image (string) is required");
  }
  if (!input.repoPath || typeof input.repoPath !== "string") {
    throw new Error("executeInContainer: repoPath (string) is required");
  }
  if (!input.command || typeof input.command !== "string") {
    throw new Error("executeInContainer: command (string) is required");
  }

  // Confirm docker is available before attempting to run.
  const avail = await checkDockerAvailable({ dockerSpawn });
  if (!avail.ok) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: `docker not available: ${avail.reason}`,
      durationMs: Date.now() - t0,
      dockerAvailable: false,
    };
  }

  // Build the docker run args. Key flags:
  //   --rm: cleanup container on exit
  //   -v <host>:<container>: bind-mount repo
  //   -w <workdir>: cwd inside container
  //   --network none: deny network egress (tests should be hermetic)
  //   <image> sh -c <command>: invoke through shell so command can use
  //     pipes/redirects/etc.
  const args = [
    "run",
    "--rm",
    "-v",
    `${input.repoPath}:${workdir}`,
    "-w",
    workdir,
    "--network",
    "none",
    input.image,
    "sh",
    "-c",
    input.command,
  ];

  // Race the docker run against the timeout. If timeout wins, we need
  // to actively kill the container — best-effort via `docker ps` →
  // `docker kill`. In practice the --rm flag plus our timeout on the
  // overall promise handles cleanup adequately.
  const runPromise = dockerSpawn(args);
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          exitCode: -2,
          stdout: "",
          stderr: `timeout after ${timeoutMs}ms`,
        }),
      timeoutMs,
    ),
  );
  const result = await Promise.race([runPromise, timeoutPromise]);

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - t0,
    dockerAvailable: true,
  };
}

/**
 * Convenience wrapper for the SWE-Bench verify pattern: apply test_patch
 * + run the target test command, return pass/fail + raw output.
 *
 * @param {Object} input
 * @param {string} input.image
 * @param {string} input.repoPath
 * @param {string} input.testPatch  Raw `git apply` patch from the SWE-Bench task
 * @param {string} input.testCommand  e.g. "pytest tests/test_x.py::test_y"
 * @param {number} [input.timeoutMs]
 * @param {Object} [opts]
 * @returns {Promise<{ pass: boolean; reason: string; raw: ExecResult }>}
 */
export async function runSweBenchVerify(input, opts = {}) {
  // Build a single shell command that:
  //   1. Applies the test_patch via git apply (if non-empty)
  //   2. Runs the test command
  //   3. Captures the test command's exit code as the final exit
  // Using `sh -c` so we can chain. The patch is piped via heredoc.
  // Escaping concern: the test_patch may contain shell metachars. Use
  // base64 encoding to dodge it.
  const patchB64 = Buffer.from(input.testPatch ?? "", "utf8").toString("base64");
  const command = input.testPatch && input.testPatch.length > 0
    ? `set -e; echo '${patchB64}' | base64 -d | git apply --check && echo '${patchB64}' | base64 -d | git apply; ${input.testCommand}`
    : input.testCommand;

  const result = await executeInContainer(
    {
      image: input.image,
      repoPath: input.repoPath,
      command,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    },
    opts,
  );

  if (!result.dockerAvailable) {
    return { pass: false, reason: "docker-unavailable", raw: result };
  }
  if (result.exitCode === -2) {
    return { pass: false, reason: "timeout", raw: result };
  }
  if (result.exitCode === 0) {
    return { pass: true, reason: "tests-passed", raw: result };
  }
  // Distinguish patch-apply failure from test failure for diagnostic clarity.
  if (/error: patch failed/i.test(result.stderr) || /error: patch failed/i.test(result.stdout)) {
    return { pass: false, reason: "patch-conflict", raw: result };
  }
  return { pass: false, reason: "tests-failed", raw: result };
}
