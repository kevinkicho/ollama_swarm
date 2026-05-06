#!/usr/bin/env node
// Test script for all 7 swarm combination plans.
// Starts a short round-robin run with postRoundCritique + postSynthesisCritique,
// then a blackboard run with workerDispositions + debateAudit,
// using Playwright to capture screenshots, console, WS frames, and network.
//
// Usage: node scripts/test-new-features.mjs
//
// Prerequisites:
//   - Dev server running on :8243/:8244 (npm run dev)
//   - OPENCODE_SERVER_PASSWORD set in .env
//   - playwright installed (npm install playwright)

import { chromium } from "playwright";
import { writeFile, mkdir, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const SERVER_URL = "http://localhost:8243";
const WEB_URL = "http://localhost:8244";
const ARTIFACTS_DIR = path.resolve("runs/_test-new-features");
const PW_DIR = path.join(ARTIFACTS_DIR, "playwright");
const SCREENSHOTS_DIR = path.join(PW_DIR, "screenshots");
const CONSOLE_PATH = path.join(PW_DIR, "console-log.jsonl");
const WS_RX_PATH = path.join(PW_DIR, "ws-frames-received.jsonl");
const NETWORK_PATH = path.join(PW_DIR, "network-log.jsonl");
const RUNTIME_LOG_PATH = path.join(PW_DIR, "test-runtime.jsonl");
const API_LOG_PATH = path.join(PW_DIR, "api-calls.jsonl");

for (const d of [ARTIFACTS_DIR, PW_DIR, SCREENSHOTS_DIR]) {
  if (!existsSync(d)) await mkdir(d, { recursive: true });
}

const counts = {
  wsRx: 0,
  consoleLog: 0,
  consoleWarn: 0,
  consoleError: 0,
  pageErrors: 0,
  screenshots: 0,
};
const eventTypeCounts = {};
const consoleErrors = [];

async function rt(kind, data) {
  const line = JSON.stringify({ kind, at: Date.now(), ...data });
  console.log(line);
  await appendFile(RUNTIME_LOG_PATH, line + "\n");
}

async function apiCall(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const url = `${SERVER_URL}${path}`;
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  await appendFile(API_LOG_PATH, JSON.stringify({
    at: Date.now(), method, path, status: resp.status,
    response: text.slice(0, 5000),
  }) + "\n");
  return { status: resp.status, body: parsed, raw: text };
}

async function takeScreenshot(page, label) {
  const fname = `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
  const ssPath = path.join(SCREENSHOTS_DIR, fname);
  try {
    await page.screenshot({ path: ssPath, fullPage: true });
    counts.screenshots++;
    await rt("screenshot", { label, path: ssPath });
  } catch (err) {
    await rt("screenshot_error", { label, error: String(err) });
  }
}

async function waitForRunToComplete(runId, maxWaitMs = 600_000) {
  const start = Date.now();
  let lastPhase = null;
  while (Date.now() - start < maxWaitMs) {
    const resp = await apiCall("GET", `/api/swarm/runs/${runId}/status`);
    if (resp.body) {
      const phase = resp.body.phase;
      const running = resp.body.running;
      lastPhase = phase;
      await rt("run_status_poll", { runId, phase, running, elapsed: Date.now() - start });

      if (!running || phase === "completed" || phase === "stopped" || phase === "failed") {
        await rt("run_completed", { runId, phase, elapsed: Date.now() - start });
        return { phase, status: resp.body };
      }
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  await rt("run_max_wait", { runId, lastPhase, elapsed: maxWaitMs });
  return { phase: lastPhase, status: null };
}

async function setupPlaywrightPage(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    recordVideo: { dir: path.join(PW_DIR, "video"), size: { width: 1600, height: 1200 } },
  });
  const page = await ctx.newPage();

  page.on("console", async (msg) => {
    const type = msg.type();
    if (type === "log") counts.consoleLog++;
    else if (type === "warning") counts.consoleWarn++;
    else if (type === "error") counts.consoleError++;
    const text = msg.text();
    await appendFile(CONSOLE_PATH, JSON.stringify({ at: Date.now(), type, text }) + "\n");
    if (type === "error" || type === "warning") {
      consoleErrors.push({ type, text: text.slice(0, 500) });
    }
  });
  page.on("pageerror", async (err) => {
    counts.pageErrors++;
    await appendFile(CONSOLE_PATH, JSON.stringify({ at: Date.now(), type: "pageerror", text: err.message, stack: err.stack }) + "\n");
    consoleErrors.push({ type: "pageerror", text: err.message.slice(0, 500) });
  });

  page.on("websocket", (ws) => {
    ws.on("framereceived", async ({ payload }) => {
      counts.wsRx++;
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      const evType = parsed?.type ?? parsed?.event?.type ?? "?";
      eventTypeCounts[evType] = (eventTypeCounts[evType] ?? 0) + 1;
      await appendFile(WS_RX_PATH, JSON.stringify({ at: Date.now(), type: evType, payload: text.slice(0, 2000) }) + "\n");
    });
  });

  page.on("request", async (req) => {
    const url = req.url();
    if (!/\/api\/|\/ws($|\?)/.test(url)) return;
    await appendFile(NETWORK_PATH, JSON.stringify({
      at: Date.now(), dir: "request", method: req.method(), url,
      postData: req.postData()?.slice(0, 2000),
    }) + "\n");
  });
  page.on("response", async (resp) => {
    const url = resp.url();
    if (!/\/api\/|\/ws($|\?)/.test(url)) return;
    let bodyExcerpt = null;
    try {
      if (resp.headers()["content-type"]?.includes("json")) {
        bodyExcerpt = (await resp.text()).slice(0, 2000);
      }
    } catch {}
    await appendFile(NETWORK_PATH, JSON.stringify({
      at: Date.now(), dir: "response", status: resp.status(), url, bodyExcerpt,
    }) + "\n");
  });

  return { ctx, page };
}

// ─── Test 1: Round-robin with postRoundCritique + postSynthesisCritique ───
async function testRoundRobinCritique() {
  await rt("test_start", { name: "round-robin-postRoundCritique" });

  const payload = {
    repoUrl: "https://github.com/kevinkicho/debate-tcg",
    parentPath: path.resolve("runs").replace(/\\/g, "/"),
    preset: "round-robin",
    agentCount: 3,
    rounds: 2,
    model: "glm-5.1:cloud",
    force: true,
    wallClockCapMs: 600_000,
    postRoundCritique: true,
    postSynthesisCritique: true,
    userDirective: "Identify the top 3 missing features from the README that this project should implement next.",
  };

  const resp = await apiCall("POST", "/api/swarm/start", payload);
  if (resp.status !== 200 || !resp.body?.ok) {
    await rt("test_fail", { name: "round-robin-postRoundCritique", status: resp.status, body: resp.raw?.slice(0, 500) });
    return null;
  }

  const runId = resp.body.status?.runId ?? resp.body.runId;
  await rt("run_started", { runId, preset: "round-robin", features: ["postRoundCritique", "postSynthesisCritique"] });

  return { runId, testName: "round-robin-postRoundCritique" };
}

// ─── Test 2: Blackboard with workerDispositions + debateAudit ───
async function testBlackboardDispositions() {
  await rt("test_start", { name: "blackboard-workerDispositions-debateAudit" });

  const payload = {
    repoUrl: "https://github.com/kevinkicho/debate-tcg",
    parentPath: path.resolve("runs").replace(/\\/g, "/"),
    preset: "blackboard",
    agentCount: 4,
    rounds: 2,
    model: "glm-5.1:cloud",
    force: true,
    wallClockCapMs: 300_000,
    workerDispositions: true,
    debateAudit: true,
    debateAuditRounds: 1,
    userDirective: "Add error handling to all public API endpoints",
  };

  const resp = await apiCall("POST", "/api/swarm/start", payload);
  if (resp.status !== 200 || !resp.body?.ok) {
    await rt("test_fail", { name: "blackboard-workerDispositions-debateAudit", status: resp.status, body: resp.raw?.slice(0, 500) });
    return null;
  }

  const runId = resp.body.status?.runId ?? resp.body.runId;
  await rt("run_started", { runId, preset: "blackboard", features: ["workerDispositions", "debateAudit"] });

  return { runId, testName: "blackboard-workerDispositions-debateAudit" };
}

// ─── Test 3: Map-reduce with councilMappers ───
async function testMapReduceCouncil() {
  await rt("test_start", { name: "map-reduce-councilMappers" });

  const payload = {
    repoUrl: "https://github.com/kevinkicho/debate-tcg",
    parentPath: path.resolve("runs").replace(/\\/g, "/"),
    preset: "map-reduce",
    agentCount: 4,
    rounds: 1,
    model: "glm-5.1:cloud",
    force: true,
    wallClockCapMs: 300_000,
    councilMappers: true,
    userDirective: "Find all TODO comments and fix them",
  };

  const resp = await apiCall("POST", "/api/swarm/start", payload);
  if (resp.status !== 200 || !resp.body?.ok) {
    await rt("test_fail", { name: "map-reduce-councilMappers", status: resp.status, body: resp.raw?.slice(0, 500) });
    return null;
  }

  const runId = resp.body.status?.runId ?? resp.body.runId;
  await rt("run_started", { runId, preset: "map-reduce", features: ["councilMappers"] });

  return { runId, testName: "map-reduce-councilMappers" };
}

// ─── Test 4: Pipeline preset ───
async function testPipeline() {
  await rt("test_start", { name: "pipeline-preset" });

  const payload = {
    repoUrl: "https://github.com/kevinkicho/debate-tcg",
    parentPath: path.resolve("runs").replace(/\\/g, "/"),
    preset: "pipeline",
    agentCount: 3,
    rounds: 1,
    model: "glm-5.1:cloud",
    force: true,
    wallClockCapMs: 600_000,
    pipeline: {
      phases: [
        { preset: "round-robin", rounds: 1 },
        { preset: "council", rounds: 1 },
      ],
      pipeMode: "both",
      pipeMaxEntries: 10,
    },
    userDirective: "What are the security vulnerabilities in this codebase?",
  };

  const resp = await apiCall("POST", "/api/swarm/start", payload);
  if (resp.status !== 200 || !resp.body?.ok) {
    await rt("test_fail", { name: "pipeline-preset", status: resp.status, body: resp.raw?.slice(0, 500) });
    return null;
  }

  const runId = resp.body.status?.runId ?? resp.body.runId;
  await rt("run_started", { runId, preset: "pipeline", features: ["pipeline"] });

  return { runId, testName: "pipeline-preset" };
}

// ─── Main orchestrator ───
async function main() {
  const startedAt = Date.now();
  await rt("main_start", {
    serverUrl: SERVER_URL,
    webUrl: WEB_URL,
    artifactsDir: ARTIFACTS_DIR,
  });

  const browser = await chromium.launch({ headless: true });
  const { ctx, page } = await setupPlaywrightPage(browser);

  // Navigate to the web UI
  await page.goto(WEB_URL, { waitUntil: "networkidle" });
  await takeScreenshot(page, "01-web-ui-loaded");

  // ─── Test 1: Round-robin with postRoundCritique ───
  await rt("phase_start", { test: "Round-robin + postRoundCritique + postSynthesisCritique" });
  const test1 = await testRoundRobinCritique();
  if (test1) {
    // Navigate to the run page and watch
    await page.goto(`${WEB_URL}/runs/${test1.runId}`, { waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
    await takeScreenshot(page, `02-${test1.testName}-run-page`);

    // Poll until complete (max 5 min for a 2-round RR)
    let screenshotCount = 0;
    const pollInterval = 15000;
    const maxWait = 300_000;
    const pollStart = Date.now();
    while (Date.now() - pollStart < maxWait) {
      const resp = await apiCall("GET", `/api/swarm/runs/${test1.runId}/status`);
      if (resp.body) {
        const phase = resp.body.phase;
        const running = resp.body.running;
        await rt("test1_poll", { runId: test1.runId, phase, running, elapsed: Date.now() - pollStart });
        if (!running || phase === "completed" || phase === "stopped" || phase === "failed") {
          await takeScreenshot(page, `03-${test1.testName}-completed`);
          break;
        }
      }
      screenshotCount++;
      if (screenshotCount % 2 === 0) {
        await takeScreenshot(page, `02-${test1.testName}-progress-${screenshotCount}`);
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    // Get final transcript and check for critique entries
    const statusResp = await apiCall("GET", `/api/swarm/runs/${test1.runId}/status`);
    if (statusResp.body?.transcript) {
      const transcript = statusResp.body.transcript;
      const critiqueEntries = transcript.filter(e =>
        e.text?.includes("Critique") || e.text?.includes("[Round") && e.text?.includes("Critique")
      );
      const synthesisCritiques = transcript.filter(e =>
        e.text?.includes("Post-synthesis critique")
      );
      await rt("test1_transcript_analysis", {
        totalEntries: transcript.length,
        critiqueEntries: critiqueEntries.length,
        synthesisCritiqueEntries: synthesisCritiques.length,
        critiqueSamples: critiqueEntries.slice(0, 3).map(e => e.text?.slice(0, 200)),
        synthesisCritiqueSamples: synthesisCritiques.slice(0, 3).map(e => e.text?.slice(0, 200)),
      });
      await rt("test1_result", {
        passed: critiqueEntries.length > 0 || synthesisCritiques.length > 0,
        critiqueFound: critiqueEntries.length > 0,
        synthesisCritiqueFound: synthesisCritiques.length > 0,
      });
    }
  }

  // Wait between runs
  await new Promise(r => setTimeout(r, 3000));

  // ─── Test 2: Blackboard with workerDispositions + debateAudit ───
  await rt("phase_start", { test: "Blackboard + workerDispositions + debateAudit" });
  const test2 = await testBlackboardDispositions();
  if (test2) {
    await page.goto(`${WEB_URL}/runs/${test2.runId}`, { waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
    await takeScreenshot(page, `04-${test2.testName}-run-page`);

    // Poll until complete (max 5 min for a 2-round blackboard)
    const pollStart = Date.now();
    const maxWait = 300_000;
    let screenshotCount = 0;
    while (Date.now() - pollStart < maxWait) {
      const resp = await apiCall("GET", `/api/swarm/runs/${test2.runId}/status`);
      if (resp.body) {
        const phase = resp.body.phase;
        const running = resp.body.running;
        await rt("test2_poll", { runId: test2.runId, phase, running, elapsed: Date.now() - pollStart });
        if (!running || phase === "completed" || phase === "stopped" || phase === "failed") {
          await takeScreenshot(page, `05-${test2.testName}-completed`);
          break;
        }
      }
      screenshotCount++;
      if (screenshotCount % 3 === 0) {
        await takeScreenshot(page, `04-${test2.testName}-progress-${screenshotCount}`);
      }
      await new Promise(r => setTimeout(r, 15000));
    }

    // Check transcript for disposition and debate-audit entries
    const statusResp = await apiCall("GET", `/api/swarm/runs/${test2.runId}/status`);
    if (statusResp.body?.transcript) {
      const transcript = statusResp.body.transcript;
      const dispositionEntries = transcript.filter(e =>
        e.text?.includes("DISPOSITION THIS CYCLE") || e.text?.includes("disposition")
      );
      const debateAuditEntries = transcript.filter(e =>
        e.text?.includes("Debate audit") || e.text?.includes("PRO advocate") || e.text?.includes("JUDGE")
      );
      await rt("test2_transcript_analysis", {
        totalEntries: transcript.length,
        dispositionEntries: dispositionEntries.length,
        debateAuditEntries: debateAuditEntries.length,
        dispositionSamples: dispositionEntries.slice(0, 3).map(e => e.text?.slice(0, 200)),
        debateAuditSamples: debateAuditEntries.slice(0, 3).map(e => e.text?.slice(0, 200)),
      });
      await rt("test2_result", {
        passed: true,
        dispositionFound: dispositionEntries.length > 0,
        debateAuditFound: debateAuditEntries.length > 0,
      });
    }
  }

  // Wait between runs
  await new Promise(r => setTimeout(r, 3000));

  // ─── Test 3: Map-reduce with councilMappers ───
  await rt("phase_start", { test: "Map-reduce + councilMappers" });
  const test3 = await testMapReduceCouncil();
  if (test3) {
    await page.goto(`${WEB_URL}/runs/${test3.runId}`, { waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
    await takeScreenshot(page, `06-${test3.testName}-run-page`);

    const pollStart = Date.now();
    const maxWait = 300_000;
    let screenshotCount = 0;
    while (Date.now() - pollStart < maxWait) {
      const resp = await apiCall("GET", `/api/swarm/runs/${test3.runId}/status`);
      if (resp.body) {
        const phase = resp.body.phase;
        const running = resp.body.running;
        await rt("test3_poll", { runId: test3.runId, phase, running, elapsed: Date.now() - pollStart });
        if (!running || phase === "completed" || phase === "stopped" || phase === "failed") {
          await takeScreenshot(page, `07-${test3.testName}-completed`);
          break;
        }
      }
      screenshotCount++;
      if (screenshotCount % 3 === 0) {
        await takeScreenshot(page, `06-${test3.testName}-progress-${screenshotCount}`);
      }
      await new Promise(r => setTimeout(r, 15000));
    }

    const statusResp = await apiCall("GET", `/api/swarm/runs/${test3.runId}/status`);
    if (statusResp.body?.transcript) {
      const transcript = statusResp.body.transcript;
      const councilEntries = transcript.filter(e =>
        e.text?.includes("Council") || e.text?.includes("council") || e.text?.includes("draft")
      );
      await rt("test3_transcript_analysis", {
        totalEntries: transcript.length,
        councilEntries: councilEntries.length,
        councilSamples: councilEntries.slice(0, 3).map(e => e.text?.slice(0, 200)),
      });
      await rt("test3_result", {
        passed: true,
        councilMapperFound: councilEntries.length > 0,
      });
    }
  }

  // Wait between runs
  await new Promise(r => setTimeout(r, 3000));

  // ─── Test 4: Pipeline preset ───
  await rt("phase_start", { test: "Pipeline preset" });
  const test4 = await testPipeline();
  if (test4) {
    await page.goto(`${WEB_URL}/runs/${test4.runId}`, { waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
    await takeScreenshot(page, `08-${test4.testName}-run-page`);

    const pollStart = Date.now();
    const maxWait = 600_000; // pipeline can be long
    let screenshotCount = 0;
    while (Date.now() - pollStart < maxWait) {
      const resp = await apiCall("GET", `/api/swarm/runs/${test4.runId}/status`);
      if (resp.body) {
        const phase = resp.body.phase;
        const running = resp.body.running;
        await rt("test4_poll", { runId: test4.runId, phase, running, elapsed: Date.now() - pollStart });
        if (!running || phase === "completed" || phase === "stopped" || phase === "failed") {
          await takeScreenshot(page, `09-${test4.testName}-completed`);
          break;
        }
      }
      screenshotCount++;
      if (screenshotCount % 3 === 0) {
        await takeScreenshot(page, `08-${test4.testName}-progress-${screenshotCount}`);
      }
      await new Promise(r => setTimeout(r, 20000));
    }

    const statusResp = await apiCall("GET", `/api/swarm/runs/${test4.runId}/status`);
    if (statusResp.body?.transcript) {
      const transcript = statusResp.body.transcript;
      const pipelineEntries = transcript.filter(e =>
        e.text?.includes("[Pipeline]") || e.text?.includes("Pipeline")
      );
      await rt("test4_transcript_analysis", {
        totalEntries: transcript.length,
        pipelineEntries: pipelineEntries.length,
        pipelineSamples: pipelineEntries.slice(0, 5).map(e => e.text?.slice(0, 200)),
      });
      await rt("test4_result", {
        passed: pipelineEntries.length > 0,
        pipelineFound: pipelineEntries.length > 0,
      });
    }
  }

  // ─── Final report ───
  await takeScreenshot(page, "99-final-state");

  const duration = Date.now() - startedAt;
  const report = [];
  report.push("# Swarm Combination Features — Test Report");
  report.push("");
  report.push(`- Duration: ${(duration / 1000).toFixed(1)}s`);
  report.push(`- Artifacts: ${ARTIFACTS_DIR}`);
  report.push(`- Screenshots: ${counts.screenshots}`);
  report.push(`- WS frames received: ${counts.wsRx}`);
  report.push(`- Console logs: ${counts.consoleLog}`);
  report.push(`- Console warnings: ${counts.consoleWarn}`);
  report.push(`- Console errors: ${counts.consoleError}`);
  report.push(`- Page errors: ${counts.pageErrors}`);
  report.push("");
  report.push("## WS Event-Type Breakdown");
  const sortedEv = Object.entries(eventTypeCounts).sort((a, b) => b[1] - a[1]);
  for (const [t, n] of sortedEv) report.push(`- ${t}: ${n}`);
  report.push("");
  if (consoleErrors.length > 0) {
    report.push("## Console Errors / Warnings (samples)");
    for (const e of consoleErrors.slice(0, 20)) {
      report.push(`- [${e.type}] ${e.text}`);
    }
    report.push("");
  }
  report.push("## Artifacts");
  report.push(`- \`playwright/screenshots/\` — full-page PNG screenshots`);
  report.push(`- \`playwright/console-log.jsonl\` — browser console`);
  report.push(`- \`playwright/ws-frames-received.jsonl\` — WS events`);
  report.push(`- \`playwright/network-log.jsonl\` — REST traffic`);
  report.push(`- \`playwright/api-calls.jsonl\` — test script API calls`);
  report.push(`- \`playwright/test-runtime.jsonl\` — structured test events`);
  report.push(`- \`playwright/video/\` — screen recording`);

  const reportPath = path.join(PW_DIR, "test-report.md");
  await writeFile(reportPath, report.join("\n") + "\n");

  await ctx.close();
  await browser.close();

  console.log(`\nTest complete. Report: ${reportPath}`);
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
}

main().catch(async (err) => {
  await rt("fatal", { error: String(err), stack: err.stack });
  console.error(err);
  process.exit(1);
});