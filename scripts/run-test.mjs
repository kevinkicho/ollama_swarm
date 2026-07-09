#!/usr/bin/env node
/**
 * Unified local validation: unit tests + localhost + API logs + Playwright UI.
 *
 * Designed for agents and humans to verify the stack end-to-end without
 * starting a full swarm run (no API keys / LLM required for the smoke path).
 *
 * Usage:
 *   node scripts/run-test.mjs
 *   node scripts/run-test.mjs --unit-only
 *   node scripts/run-test.mjs --ui-only
 *   node scripts/run-test.mjs --skip-unit
 *   node scripts/run-test.mjs --no-start          # reuse existing dev server
 *   node scripts/run-test.mjs --out=runs/_run-test-custom
 *   RUN_TEST_LIVE=1 node scripts/run-test.mjs --live-smoke   # real run-start regression
 *
 * Artifacts (default: runs/_run-test-<timestamp>/):
 *   REPORT.json          machine-readable pass/fail per check
 *   REPORT.md            human summary
 *   logs/unit-test.log   npm test output
 *   logs/dev-server.log  dev.mjs stdout/stderr (when started here)
 *   logs/api.log         API probe results
 *   playwright/          screenshots, console.jsonl, ws-frames.jsonl
 */

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DEFAULT_SERVER_PORT = 8243;
const DEFAULT_WEB_PORT = 8244;

function parseArgs(argv) {
  const flags = new Set();
  const kv = {};
  for (const a of argv) {
    if (a.startsWith("--out=")) kv.out = a.slice("--out=".length);
    else if (a.startsWith("--server-port=")) kv.serverPort = Number(a.slice("--server-port=".length));
    else if (a.startsWith("--web-port=")) kv.webPort = Number(a.slice("--web-port=".length));
    else if (a.startsWith("--")) flags.add(a.replace(/^--/, ""));
  }
  return { flags, kv };
}

const { flags, kv } = parseArgs(process.argv.slice(2));
const unitOnly = flags.has("unit-only");
const uiOnly = flags.has("ui-only");
const skipUnit = flags.has("skip-unit") || uiOnly;
const skipUi = flags.has("skip-ui") || unitOnly;
const noStart = flags.has("no-start");
const liveSmoke = flags.has("live-smoke");
const liveSmokeEnabled = process.env.RUN_TEST_LIVE === "1";
const liveSmokePreset = process.env.RUN_TEST_PRESET ?? "baseline";
const liveSmokeTimeoutMs = Number(process.env.RUN_TEST_START_TIMEOUT_MS ?? 30_000);
const serverPort = kv.serverPort ?? DEFAULT_SERVER_PORT;
const webPort = kv.webPort ?? DEFAULT_WEB_PORT;
const serverUrl = `http://127.0.0.1:${serverPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(kv.out ?? path.join(ROOT, "runs", `_run-test-${ts}`));
const logsDir = path.join(outDir, "logs");
const pwDir = path.join(outDir, "playwright");
const screenshotsDir = path.join(pwDir, "screenshots");

/** @type {{ id: string, phase: string, status: "pass"|"fail"|"warn"|"skip", detail?: string, at: number }[]} */
const checks = [];
let devChild = null;
let devLogStream = null;
let weStartedDev = false;

function record(phase, id, status, detail = "") {
  const entry = { id, phase, status, detail, at: Date.now() };
  checks.push(entry);
  const icon = status === "pass" ? "✓" : status === "warn" ? "⚠" : status === "skip" ? "○" : "✕";
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`[run-test] ${icon} ${phase}/${id}${suffix}`);
  return status !== "fail";
}

async function ensureDirs() {
  for (const d of [outDir, logsDir, pwDir, screenshotsDir]) {
    await mkdir(d, { recursive: true });
  }
}

function isPortOpen(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, label, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} :${port} not reachable after ${timeoutMs}ms`);
}

function treeKill(child) {
  if (!child || child.pid === undefined || child.killed || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      try { child.kill(); } catch {}
    }
    return;
  }
  try { child.kill("SIGTERM"); } catch {}
}

async function shutdownDev() {
  if (!weStartedDev && !devChild) return;
  console.log("[run-test] stopping dev server we started");
  if (devChild) {
    treeKill(devChild);
    devChild.stdout?.destroy();
    devChild.stderr?.destroy();
    devChild = null;
  }
  if (devLogStream) {
    devLogStream.end();
    devLogStream = null;
  }
  // Fire-and-forget port cleanup — spawnSync kill-port can hang on Windows npm shims.
  for (const p of [serverPort, webPort]) {
    try {
      const killer = spawn("npx", ["kill-port", String(p)], {
        cwd: ROOT,
        stdio: "ignore",
        windowsHide: true,
        detached: true,
        shell: process.platform === "win32",
      });
      killer.unref();
    } catch {}
  }
  weStartedDev = false;
}

async function runUnitTests() {
  const logPath = path.join(logsDir, "unit-test.log");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.write(`=== unit tests started ${new Date().toISOString()} ===\n`);

  return new Promise((resolve) => {
    const child = spawn("npm", ["test"], {
      cwd: ROOT,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD:
          process.env.OPENCODE_SERVER_PASSWORD?.length > 0
            ? process.env.OPENCODE_SERVER_PASSWORD
            : "test-only",
      },
      shell: process.platform === "win32",
      windowsHide: true,
    });

    child.stdout.on("data", (d) => logStream.write(d));
    child.stderr.on("data", (d) => logStream.write(d));
    child.on("close", (code) => {
      logStream.write(`\n=== exit code ${code} ===\n`);
      logStream.end();
      if (code === 0) {
        record("unit", "npm_test", "pass", logPath);
      } else {
        record("unit", "npm_test", "fail", `exit ${code}; see ${logPath}`);
      }
      resolve(code === 0);
    });
    child.on("error", (err) => {
      logStream.write(`\nspawn error: ${err.message}\n`);
      logStream.end();
      record("unit", "npm_test", "fail", err.message);
      resolve(false);
    });
  });
}

async function startDevServerIfNeeded() {
  const backendUp = await isPortOpen(serverPort);
  const webUp = await isPortOpen(webPort);

  if (backendUp && webUp) {
    record("dev", "ports_ready", "pass", `reusing :${serverPort}/:${webPort}`);
    return true;
  }

  if (noStart) {
    record(
      "dev",
      "ports_ready",
      "fail",
      `--no-start but backend=${backendUp} web=${webUp}`,
    );
    return false;
  }

  if (backendUp !== webUp) {
    record(
      "dev",
      "ports_ready",
      "warn",
      `partial stack backend=${backendUp} web=${webUp}; starting fresh dev`,
    );
    for (const p of [serverPort, webPort]) {
      try {
        spawnSync("npx", ["kill-port", String(p)], {
          cwd: ROOT,
          stdio: "ignore",
          windowsHide: true,
          shell: process.platform === "win32",
        });
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  const logPath = path.join(logsDir, "dev-server.log");
  devLogStream = fs.createWriteStream(logPath, { flags: "a" });
  devLogStream.write(`=== dev server started ${new Date().toISOString()} ===\n`);

  const devScript = path.join(ROOT, "scripts", "dev.mjs");
  devChild = spawn(process.execPath, [devScript, "--no-watch"], {
    cwd: ROOT,
    env: {
      ...process.env,
      SERVER_PORT: String(serverPort),
      WEB_PORT: String(webPort),
      OPENCODE_SERVER_PASSWORD:
        process.env.OPENCODE_SERVER_PASSWORD?.length > 0
          ? process.env.OPENCODE_SERVER_PASSWORD
          : "test-only",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  weStartedDev = true;

  devChild.stdout.on("data", (d) => devLogStream.write(d));
  devChild.stderr.on("data", (d) => devLogStream.write(d));
  devChild.on("exit", (code, signal) => {
    devLogStream?.write(`\n=== dev exited code=${code} signal=${signal} ===\n`);
  });

  try {
    await waitForPort(serverPort, "backend");
    await waitForPort(webPort, "web");
    record("dev", "ports_ready", "pass", `started :${serverPort}/:${webPort}; log ${logPath}`);
    return true;
  } catch (err) {
    record("dev", "ports_ready", "fail", err.message);
    return false;
  }
}

async function logApi(line) {
  await appendFile(path.join(logsDir, "api.log"), line + "\n");
}

async function probeApi() {
  let allOk = true;

  async function getJson(label, url, opts = {}) {
    const { requiredFields = [], failOnNon200 = true, warnOnly = false } = opts;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const text = await resp.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      await logApi(JSON.stringify({ at: Date.now(), label, url, status: resp.status, body: text.slice(0, 2000) }));

      if (failOnNon200 && resp.status !== 200) {
        const st = warnOnly ? "warn" : "fail";
        record("api", label, st, `HTTP ${resp.status}`);
        if (!warnOnly) allOk = false;
        return null;
      }

      for (const f of requiredFields) {
        if (body?.[f] === undefined) {
          record("api", label, "fail", `missing field ${f}`);
          allOk = false;
          return null;
        }
      }

      record("api", label, "pass", `HTTP ${resp.status}`);
      return body;
    } catch (err) {
      await logApi(JSON.stringify({ at: Date.now(), label, url, error: String(err) }));
      const st = warnOnly ? "warn" : "fail";
      record("api", label, st, err.message);
      if (!warnOnly) allOk = false;
      return null;
    }
  }

  await getJson("health_direct", `${serverUrl}/api/health`, {
    requiredFields: ["defaultModel", "ollamaProbe"],
    warnOnly: false,
  });

  const health = await getJson("health_proxy", `${webUrl}/api/health`, {
    requiredFields: ["defaultModel"],
    warnOnly: false,
  });

  if (health && health.ok === false) {
    record(
      "api",
      "ollama_reachable",
      "warn",
      `health.ok=false probe=${health.ollamaProbe?.status ?? "?"}`,
    );
  } else if (health) {
    record("api", "ollama_reachable", "pass");
  }

  await getJson("providers", `${serverUrl}/api/providers`, {
    requiredFields: ["gateway", "meta"],
    warnOnly: true,
  });

  // Reconfig route exists and rejects unknown/inactive runs (no LLM required).
  try {
    const resp = await fetch(`${serverUrl}/api/swarm/reconfig`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: "_run-test-inactive-run-id",
        extendWallClockCapMin: 5,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await resp.text();
    await logApi(JSON.stringify({ at: Date.now(), label: "reconfig_inactive", status: resp.status, body: text.slice(0, 500) }));
    if (resp.status === 404) {
      record("api", "reconfig_inactive", "pass", "404 for inactive runId");
    } else {
      record("api", "reconfig_inactive", "fail", `expected 404, got ${resp.status}`);
      allOk = false;
    }
  } catch (err) {
    record("api", "reconfig_inactive", "fail", err.message);
    allOk = false;
  }

  return allOk;
}

async function runPlaywrightUi() {
  const consolePath = path.join(pwDir, "console.jsonl");
  const wsPath = path.join(pwDir, "ws-frames.jsonl");
  const consoleEntries = [];
  let wsFrames = 0;
  let allOk = true;

  async function launchBrowser() {
    return chromium.launch({ headless: true });
  }

  let browser;
  try {
    browser = await launchBrowser();
  } catch (firstErr) {
    const missing = /Executable doesn't exist|Please run the following command/i.test(firstErr.message);
    if (missing) {
      console.log("[run-test] Playwright browser missing — installing chromium...");
      const install = spawnSync("npx", ["playwright", "install", "chromium"], {
        cwd: ROOT,
        stdio: "inherit",
        shell: process.platform === "win32",
        windowsHide: true,
      });
      if (install.status === 0) {
        try {
          browser = await launchBrowser();
          record("ui", "playwright_install", "pass", "chromium installed on demand");
        } catch (retryErr) {
          record("ui", "playwright_launch", "fail", retryErr.message);
          return false;
        }
      } else {
        record("ui", "playwright_launch", "fail", `${firstErr.message} (install exit ${install.status})`);
        return false;
      }
    } else {
      record("ui", "playwright_launch", "fail", firstErr.message);
      return false;
    }
  }

  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  page.on("console", async (msg) => {
    const entry = { at: Date.now(), type: msg.type(), text: msg.text() };
    consoleEntries.push(entry);
    await appendFile(consolePath, JSON.stringify(entry) + "\n");
  });
  page.on("pageerror", async (err) => {
    const entry = { at: Date.now(), type: "pageerror", text: err.message, stack: err.stack };
    consoleEntries.push(entry);
    await appendFile(consolePath, JSON.stringify(entry) + "\n");
  });
  page.on("websocket", (ws) => {
    ws.on("framereceived", async ({ payload }) => {
      wsFrames++;
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      let type = "?";
      try { type = JSON.parse(text)?.type ?? type; } catch {}
      await appendFile(wsPath, JSON.stringify({ at: Date.now(), type, payload: text.slice(0, 1500) }) + "\n");
    });
  });

  try {
    const resp = await page.goto(webUrl + "/", { waitUntil: "networkidle", timeout: 30_000 });
    if (!resp || resp.status() >= 400) {
      record("ui", "page_load", "fail", `status ${resp?.status() ?? "none"}`);
      allOk = false;
    } else {
      record("ui", "page_load", "pass", `HTTP ${resp.status()}`);
    }

    const form = page.locator("#setup-form");
    try {
      await form.waitFor({ state: "visible", timeout: 10_000 });
      record("ui", "setup_form_visible", "pass");
    } catch {
      record("ui", "setup_form_visible", "fail", "#setup-form not visible");
      allOk = false;
    }

    const startBtn = page.locator('button[type="submit"], button:has-text("Start")').first();
    if (await startBtn.count() > 0) {
      record("ui", "start_button_present", "pass");
    } else {
      record("ui", "start_button_present", "fail");
      allOk = false;
    }

    const title = await page.title();
    if (title && title.length > 0) {
      record("ui", "document_title", "pass", title);
    } else {
      record("ui", "document_title", "warn", "empty title");
    }

    await page.screenshot({
      path: path.join(screenshotsDir, "01-setup-form.png"),
      fullPage: false,
    });
    record("ui", "screenshot_setup", "pass", path.join(screenshotsDir, "01-setup-form.png"));

    // Exercise preset tabs if present (read-only; never clicks Start).
    const presetBtn = page.locator('button:has-text("Blackboard"), button:has-text("Council")').first();
    if (await presetBtn.count() > 0) {
      await presetBtn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({
        path: path.join(screenshotsDir, "02-preset-clicked.png"),
        fullPage: false,
      });
      record("ui", "preset_interaction", "pass");
    } else {
      record("ui", "preset_interaction", "warn", "no preset button found");
    }

    const pageErrors = consoleEntries.filter((e) => e.type === "pageerror");
    const consoleErrors = consoleEntries.filter((e) => e.type === "error");
    if (pageErrors.length === 0) {
      record("ui", "no_page_errors", "pass");
    } else {
      record("ui", "no_page_errors", "fail", `${pageErrors.length} pageerror(s)`);
      allOk = false;
    }

    const benign = /favicon|vite.*ws|WebSocket.*closed|Failed to load resource.*favicon/i;
    const realConsoleErrors = consoleErrors.filter((e) => !benign.test(e.text));
    if (realConsoleErrors.length === 0) {
      record("ui", "no_console_errors", "pass", `${consoleErrors.length} total (${consoleErrors.length - realConsoleErrors.length} ignored)`);
    } else {
      record(
        "ui",
        "no_console_errors",
        "fail",
        `${realConsoleErrors.length} error(s); first: ${realConsoleErrors[0].text.slice(0, 120)}`,
      );
      allOk = false;
    }

    if (wsFrames > 0) {
      record("ui", "websocket_frames", "pass", `${wsFrames} frame(s)`);
    } else {
      record("ui", "websocket_frames", "warn", "no WS frames captured (idle setup page may be ok)");
    }
  } catch (err) {
    record("ui", "playwright_flow", "fail", err.message);
    allOk = false;
  } finally {
    await browser.close();
  }

  await writeFile(
    path.join(pwDir, "console-summary.json"),
    JSON.stringify({ consoleEntries, wsFrames }, null, 2),
  );

  return allOk;
}

const SEED_PREFIXES = [
  "Memory: surfaced",
  "Design memory: surfaced",
  "Seed: ",
  "Goal-generation pre-pass:",
];

const TERMINAL_PHASES = new Set(["stopped", "completed", "failed"]);

function runIdFromDividerText(text) {
  return (text.match(/runId=([^|]+)/) ?? [])[1];
}

function countRunStartDividers(transcript, runId) {
  return (transcript ?? []).filter(
    (t) =>
      t.role === "system" &&
      t.text?.startsWith("▸▸RUN-START▸▸") &&
      runIdFromDividerText(t.text) === runId,
  ).length;
}

function duplicateSeedPrefixes(transcript) {
  const counts = {};
  for (const t of transcript ?? []) {
    if (t.role !== "system" || !t.text) continue;
    for (const prefix of SEED_PREFIXES) {
      if (t.text.startsWith(prefix)) {
        counts[prefix] = (counts[prefix] ?? 0) + 1;
      }
    }
  }
  return Object.entries(counts).filter(([, n]) => n > 1);
}

async function fetchRunStatus(runId) {
  const resp = await fetch(
    `${serverUrl}/api/swarm/runs/${encodeURIComponent(runId)}/status`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!resp.ok) {
    return { ok: false, status: resp.status, body: null };
  }
  const body = await resp.json();
  return { ok: true, status: resp.status, body };
}

async function startLiveRun(defaultModel) {
  const payload = {
    preset: liveSmokePreset,
    parentPath: ROOT,
    repoUrl: "",
    userDirective:
      "Run-start smoke test only: do not modify files. Reply with a one-line acknowledgement.",
    wallClockCapMs: 90_000,
    tokenBudget: 100_000,
    force: true,
    agentCount: 1,
    rounds: 0,
    model: defaultModel ?? "glm-5.1:cloud",
  };

  try {
    const resp = await fetch(`${serverUrl}/api/swarm/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await resp.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 300)}`, payload, body };
    }
    const runId = body?.runId ?? body?.status?.runId ?? null;
    if (!runId) {
      return { ok: false, error: "start response missing runId", payload, body };
    }
    return { ok: true, runId, payload, body };
  } catch (err) {
    return { ok: false, error: err.message, payload };
  }
}

async function runLiveSmoke() {
  const logPath = path.join(logsDir, "live-smoke.json");
  /** @type {Record<string, unknown>} */
  const artifact = { startedAt: new Date().toISOString(), preset: liveSmokePreset };
  let allOk = true;

  if (!liveSmokeEnabled) {
    record(
      "live-smoke",
      "gate",
      "skip",
      "set RUN_TEST_LIVE=1 to enable real LLM run-start checks",
    );
    artifact.skipped = true;
    artifact.reason = "RUN_TEST_LIVE!=1";
    await writeFile(logPath, JSON.stringify(artifact, null, 2));
    return true;
  }

  let health;
  try {
    const resp = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
    health = await resp.json();
  } catch (err) {
    record("live-smoke", "health", "fail", err.message);
    artifact.error = err.message;
    await writeFile(logPath, JSON.stringify(artifact, null, 2));
    return false;
  }

  const defaultModel = health?.defaultModel;
  artifact.defaultModel = defaultModel;

  const start = await startLiveRun(defaultModel);
  artifact.start = start;
  if (!start.ok || !start.runId) {
    record("live-smoke", "start_run", "fail", start.error ?? "unknown start failure");
    await writeFile(logPath, JSON.stringify(artifact, null, 2));
    return false;
  }

  const runId = start.runId;
  record("live-smoke", "start_run", "pass", `runId=${runId} preset=${liveSmokePreset}`);
  artifact.runId = runId;

  try {
    const reconfigResp = await fetch(`${serverUrl}/api/swarm/reconfig`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, extendWallClockCapMin: 5 }),
      signal: AbortSignal.timeout(10_000),
    });
    const reconfigText = await reconfigResp.text();
    let reconfigBody = null;
    try { reconfigBody = JSON.parse(reconfigText); } catch {}
    artifact.reconfig = { status: reconfigResp.status, body: reconfigBody ?? reconfigText.slice(0, 500) };
    if (reconfigResp.status === 200 && reconfigBody?.ok && reconfigBody?.changes?.wallClockCapMs) {
      record("live-smoke", "reconfig_extend", "pass", reconfigBody.message ?? "wall-clock extended");
    } else {
      record(
        "live-smoke",
        "reconfig_extend",
        "fail",
        `HTTP ${reconfigResp.status}: ${reconfigText.slice(0, 200)}`,
      );
      allOk = false;
    }
  } catch (err) {
    artifact.reconfig = { error: err.message };
    record("live-smoke", "reconfig_extend", "fail", err.message);
    allOk = false;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    record("live-smoke", "playwright_launch", "fail", err.message);
    artifact.error = err.message;
    await writeFile(logPath, JSON.stringify(artifact, null, 2));
    return false;
  }

  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const runUrl = `${webUrl}/runs/${encodeURIComponent(runId)}`;
  await page.goto(runUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const pollStart = Date.now();
  const earlyWindowMs = 10_000;
  /** @type {Array<Record<string, unknown>>} */
  const samples = [];
  let lastStatus = null;

  while (Date.now() - pollStart < liveSmokeTimeoutMs) {
    const statusResp = await fetchRunStatus(runId);
    const ui = await page.evaluate(() => {
      const pill = document.querySelector('span[title^="Phase:"]');
      const phaseText = pill?.textContent?.trim() ?? "";
      const uiPhase = phaseText.split("·")[0]?.trim() || null;
      const transcriptRoot =
        document.querySelector(".transcript-scroll") ??
        document.querySelector('[class*="transcript"]');
      const textBlob = transcriptRoot?.textContent ?? "";
      const runStartMatches = (textBlob.match(/RUN-START/g) ?? []).length;
      return {
        uiPhase,
        runStartDomMatches: runStartMatches,
        transcriptChars: textBlob.length,
        href: location.href,
      };
    });

    if (statusResp.ok) {
      lastStatus = statusResp.body;
      samples.push({
        at: Date.now() - pollStart,
        phase: statusResp.body.phase,
        transcriptLen: statusResp.body.transcript?.length ?? 0,
        uiPhase: ui.uiPhase,
        runStartDomMatches: ui.runStartDomMatches,
        transcriptChars: ui.transcriptChars,
      });
    }

    const elapsed = Date.now() - pollStart;
    const transcriptLen = lastStatus?.transcript?.length ?? 0;
    const runStartCount = countRunStartDividers(lastStatus?.transcript, runId);
    const dupSeeds = duplicateSeedPrefixes(lastStatus?.transcript);

    if (
      elapsed >= 2000 &&
      transcriptLen >= 1 &&
      runStartCount === 1 &&
      dupSeeds.length === 0
    ) {
      break;
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  artifact.samples = samples;
  artifact.lastStatus = lastStatus
    ? {
        phase: lastStatus.phase,
        transcriptLen: lastStatus.transcript?.length ?? 0,
      }
    : null;

  await page.screenshot({
    path: path.join(screenshotsDir, "03-run-started.png"),
    fullPage: false,
  });
  record(
    "live-smoke",
    "screenshot",
    "pass",
    path.join(screenshotsDir, "03-run-started.png"),
  );

  await browser.close();

  const transcript = lastStatus?.transcript ?? [];
  const transcriptLen = transcript.length;

  if (transcriptLen < 1) {
    record("live-smoke", "transcript_grows", "fail", `len=${transcriptLen}`);
    allOk = false;
  } else {
    record("live-smoke", "transcript_grows", "pass", `len=${transcriptLen}`);
  }

  const runStartCount = countRunStartDividers(transcript, runId);
  if (runStartCount !== 1) {
    record("live-smoke", "single_run_start", "fail", `count=${runStartCount}`);
    allOk = false;
  } else {
    record("live-smoke", "single_run_start", "pass");
  }

  const dupSeeds = duplicateSeedPrefixes(transcript);
  if (dupSeeds.length > 0) {
    record(
      "live-smoke",
      "no_duplicate_seeds",
      "fail",
      dupSeeds.map(([p, n]) => `${p}×${n}`).join(", "),
    );
    allOk = false;
  } else {
    record("live-smoke", "no_duplicate_seeds", "pass");
  }

  const earlySamples = samples.filter((s) => s.at <= earlyWindowMs);
  const falselyTerminalEarly = earlySamples.filter((s) => TERMINAL_PHASES.has(s.phase));
  const sawLivePhase = earlySamples.some((s) => !TERMINAL_PHASES.has(s.phase) && s.phase !== "idle");
  if (falselyTerminalEarly.length > 0 && !sawLivePhase) {
    record(
      "live-smoke",
      "phase_not_false_stopped",
      "fail",
      `early terminal phases: ${falselyTerminalEarly.map((s) => s.phase).join(", ")}`,
    );
    allOk = false;
  } else if (sawLivePhase) {
    record("live-smoke", "phase_not_false_stopped", "pass", "saw live phase in first 10s");
  } else if (samples.length === 0) {
    record("live-smoke", "phase_not_false_stopped", "fail", "no status samples");
    allOk = false;
  } else {
    record(
      "live-smoke",
      "phase_not_false_stopped",
      "warn",
      "no live phase in first 10s (run may have ended quickly)",
    );
  }

  const uiPhase = samples.at(-1)?.uiPhase;
  const serverPhase = lastStatus?.phase;
  if (
    uiPhase &&
    serverPhase &&
    TERMINAL_PHASES.has(uiPhase) &&
    !TERMINAL_PHASES.has(serverPhase)
  ) {
    record(
      "live-smoke",
      "ui_phase_matches_server",
      "fail",
      `ui=${uiPhase} server=${serverPhase}`,
    );
    allOk = false;
  } else if (uiPhase && serverPhase) {
    record("live-smoke", "ui_phase_matches_server", "pass", `ui=${uiPhase} server=${serverPhase}`);
  } else {
    record("live-smoke", "ui_phase_matches_server", "warn", "could not compare ui/server phase");
  }

  try {
    await fetch(`${serverUrl}/api/swarm/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    record("live-smoke", "cleanup_stop", "pass");
  } catch (err) {
    record("live-smoke", "cleanup_stop", "warn", err.message);
  }

  artifact.finishedAt = new Date().toISOString();
  artifact.ok = allOk;
  await writeFile(logPath, JSON.stringify(artifact, null, 2));

  return allOk;
}

async function writeReport(startedAt) {
  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  const passed = checks.filter((c) => c.status === "pass");
  const skipped = checks.filter((c) => c.status === "skip");
  const ok = failed.length === 0;

  const report = {
    ok,
    startedAt,
    finishedAt: new Date().toISOString(),
    outDir,
    serverUrl,
    webUrl,
    summary: {
      pass: passed.length,
      fail: failed.length,
      warn: warned.length,
      skip: skipped.length,
    },
    checks,
  };

  await writeFile(path.join(outDir, "REPORT.json"), JSON.stringify(report, null, 2));

  const md = [
    `# run-test report`,
    ``,
    `**Result:** ${ok ? "PASS" : "FAIL"}`,
    `**Started:** ${startedAt}`,
    `**Finished:** ${report.finishedAt}`,
    `**Output:** \`${outDir}\``,
    ``,
    `| Status | Count |`,
    `|--------|------:|`,
    `| pass   | ${passed.length} |`,
    `| fail   | ${failed.length} |`,
    `| warn   | ${warned.length} |`,
    `| skip   | ${skipped.length} |`,
    ``,
    `## Checks`,
    ``,
    ...checks.map((c) => `- **${c.status}** \`${c.phase}/${c.id}\`${c.detail ? ` — ${c.detail}` : ""}`),
    ``,
    `## Artifacts`,
    ``,
    `- \`logs/unit-test.log\` — npm test output`,
    `- \`logs/dev-server.log\` — dev server output (if started here)`,
    `- \`logs/api.log\` — API probe lines`,
    `- \`playwright/screenshots/\` — UI captures`,
    `- \`playwright/console.jsonl\` — browser console`,
    `- \`playwright/ws-frames.jsonl\` — websocket frames`,
    `- \`logs/live-smoke.json\` — run-start regression (with \`--live-smoke\`)`,
    ``,
  ].join("\n");

  await writeFile(path.join(outDir, "REPORT.md"), md);
  return ok;
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[run-test] output → ${outDir}`);
  await ensureDirs();

  let ok = true;

  if (!skipUnit) {
    console.log("\n[run-test] === phase: unit tests ===");
    ok = (await runUnitTests()) && ok;
  } else {
    record("unit", "npm_test", "skip", "--skip-unit or --ui-only");
  }

  if (!skipUi) {
    console.log("\n[run-test] === phase: localhost ===");
    const devOk = await startDevServerIfNeeded();
    ok = devOk && ok;

    if (devOk) {
      console.log("\n[run-test] === phase: API probes ===");
      ok = (await probeApi()) && ok;

      console.log("\n[run-test] === phase: Playwright UI ===");
      ok = (await runPlaywrightUi()) && ok;

      if (liveSmoke) {
        console.log("\n[run-test] === phase: live-smoke ===");
        ok = (await runLiveSmoke()) && ok;
      }
    }
  } else {
    record("ui", "playwright_flow", "skip", "--skip-ui or --unit-only");
    if (liveSmoke) {
      record("live-smoke", "gate", "skip", "--unit-only or --skip-ui (needs dev server)");
    }
  }

  const reportOk = await writeReport(startedAt);
  await shutdownDev();

  console.log(`\n[run-test] ${reportOk ? "PASS" : "FAIL"} — see ${path.join(outDir, "REPORT.md")}`);
  process.exit(reportOk ? 0 : 1);
}

process.on("SIGINT", async () => {
  await shutdownDev();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await shutdownDev();
  process.exit(143);
});

main().catch(async (err) => {
  console.error("[run-test] fatal:", err);
  await shutdownDev();
  process.exit(1);
});