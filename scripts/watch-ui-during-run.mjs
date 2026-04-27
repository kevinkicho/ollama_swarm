#!/usr/bin/env node
// Persistent Playwright watcher — opens the swarm UI in headless
// Chromium, stays attached for the whole run, and captures every
// observable signal the browser sees:
//
//   - WebSocket frames (received + sent) — the swarm's full event
//     stream as the UI sees it. Includes phase changes, transcript
//     appends, agent state, board mutations, streaming text.
//   - Console messages (log / warn / error / pageerror)
//   - Network requests + responses for /api/* + /ws (skips noise)
//   - Periodic full-page screenshots
//   - Periodic DOM snapshots (innerHTML)
//
// Exits when a swarm_state WS frame announces a terminal phase
// (completed / stopped / failed) OR when --maxWaitMin elapses.
//
// Usage (standard monitor trio):
//   node scripts/watch-ui-during-run.mjs --runId=<uuid> --runDir=runs/_monitor/<runId>
//
// Args:
//   --webUrl       UI base URL (default http://localhost:8244)
//   --runId        the runId to watch (used to early-exit on terminal)
//   --runDir       where to write artifacts (default runs/_monitor/<runId>)
//   --intervalSec  screenshot / DOM snapshot cadence (default 30)
//   --maxWaitMin   safety cap (default 30)

import { chromium } from "playwright";
import { writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const WEB_URL = args.webUrl ?? "http://localhost:8244";
const RUN_ID = args.runId;
const RUN_DIR = args.runDir ?? `runs/_monitor/${RUN_ID ?? "unspecified"}`;
const INTERVAL_MS = Number(args.intervalSec ?? 30) * 1000;
const MAX_WAIT_MS = Number(args.maxWaitMin ?? 30) * 60 * 1000;

if (!RUN_ID) {
  console.error("--runId=<uuid> is required");
  process.exit(2);
}

const RUN_DIR_ABS = path.resolve(RUN_DIR);
const PW_DIR = path.join(RUN_DIR_ABS, "playwright");
const SCREENSHOTS_DIR = path.join(PW_DIR, "screenshots");
const DOM_DIR = path.join(PW_DIR, "dom");
const WS_RX_PATH = path.join(PW_DIR, "ws-frames-received.jsonl");
const WS_TX_PATH = path.join(PW_DIR, "ws-frames-sent.jsonl");
const CONSOLE_PATH = path.join(PW_DIR, "console-log.jsonl");
const NETWORK_PATH = path.join(PW_DIR, "network-log.jsonl");
const RUNTIME_LOG_PATH = path.join(PW_DIR, "watcher-runtime.jsonl");
const SUMMARY_PATH = path.join(PW_DIR, "ui-watcher-report.md");

for (const d of [PW_DIR, SCREENSHOTS_DIR, DOM_DIR]) {
  if (!existsSync(d)) await mkdir(d, { recursive: true });
}

const startedAt = Date.now();
const counts = {
  wsRx: 0,
  wsTx: 0,
  consoleLog: 0,
  consoleWarn: 0,
  consoleError: 0,
  pageErrors: 0,
  networkReq: 0,
  networkResp: 0,
  screenshots: 0,
  domSnapshots: 0,
};
const eventTypeCounts = {}; // ws-rx event type → count
const consoleSamples = []; // first ~30 unique console messages
let terminalPhase = null;

async function rt(kind, data) {
  const line = JSON.stringify({ kind, at: Date.now(), ...data });
  console.log(line);
  await appendFile(RUNTIME_LOG_PATH, line + "\n");
}

console.log(`ui-watcher: ${WEB_URL} → ${PW_DIR}`);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page = await ctx.newPage();

// Console + page errors
page.on("console", async (msg) => {
  const type = msg.type();
  if (type === "log") counts.consoleLog++;
  else if (type === "warning") counts.consoleWarn++;
  else if (type === "error") counts.consoleError++;
  const text = msg.text();
  await appendFile(
    CONSOLE_PATH,
    JSON.stringify({ at: Date.now(), type, text }) + "\n",
  );
  if (consoleSamples.length < 30) consoleSamples.push({ type, text: text.slice(0, 200) });
});
page.on("pageerror", async (err) => {
  counts.pageErrors++;
  await appendFile(
    CONSOLE_PATH,
    JSON.stringify({ at: Date.now(), type: "pageerror", text: err.message, stack: err.stack }) + "\n",
  );
});

// Network — filter to /api/* and /ws so we don't drown in HMR + assets.
page.on("request", async (req) => {
  const url = req.url();
  if (!/\/api\/|\/ws($|\?)/.test(url)) return;
  counts.networkReq++;
  await appendFile(
    NETWORK_PATH,
    JSON.stringify({
      at: Date.now(),
      dir: "request",
      method: req.method(),
      url,
      postData: req.postData()?.slice(0, 2000),
    }) + "\n",
  );
});
page.on("response", async (resp) => {
  const url = resp.url();
  if (!/\/api\/|\/ws($|\?)/.test(url)) return;
  counts.networkResp++;
  let bodyExcerpt = null;
  try {
    if (resp.headers()["content-type"]?.includes("json")) {
      bodyExcerpt = (await resp.text()).slice(0, 2000);
    }
  } catch {
    // body read can fail on websocket upgrade; that's fine
  }
  await appendFile(
    NETWORK_PATH,
    JSON.stringify({
      at: Date.now(),
      dir: "response",
      status: resp.status(),
      url,
      bodyExcerpt,
    }) + "\n",
  );
});

// WebSocket frames — the meat. Each frame is a swarm event the UI
// renders. Parse to detect terminal phase early-exit.
page.on("websocket", (ws) => {
  rt("ws_open", { url: ws.url() });
  ws.on("framesent", async ({ payload }) => {
    counts.wsTx++;
    const text = typeof payload === "string" ? payload : payload.toString("utf8");
    await appendFile(
      WS_TX_PATH,
      JSON.stringify({ at: Date.now(), payload: text.slice(0, 4000) }) + "\n",
    );
  });
  ws.on("framereceived", async ({ payload }) => {
    counts.wsRx++;
    const text = typeof payload === "string" ? payload : payload.toString("utf8");
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON frame; rare for our WS but handle
    }
    const evType = parsed?.type ?? parsed?.event?.type ?? "?";
    eventTypeCounts[evType] = (eventTypeCounts[evType] ?? 0) + 1;
    await appendFile(
      WS_RX_PATH,
      JSON.stringify({ at: Date.now(), type: evType, payload: text.slice(0, 4000) }) + "\n",
    );
    // Early-exit on terminal phase.
    if (parsed && parsed.type === "swarm_state") {
      const phase = parsed.phase;
      if (phase === "completed" || phase === "stopped" || phase === "failed") {
        if (!terminalPhase) {
          terminalPhase = phase;
          rt("terminal_phase_detected", { phase });
        }
      }
    }
  });
  ws.on("close", () => {
    rt("ws_close", { url: ws.url() });
  });
});

await page.goto(WEB_URL, { waitUntil: "networkidle" });
await rt("page_loaded", { url: WEB_URL });

// Periodic capture loop. Exits when terminalPhase is set + a small
// settle window passes (so we capture the final transcript entries
// + run-finished bubble).
let pollNum = 0;
let terminalSeenAt = null;
const SETTLE_MS = 5_000;

while (true) {
  pollNum++;
  const t0 = Date.now();
  try {
    const ssPath = path.join(SCREENSHOTS_DIR, `screenshot-${String(pollNum).padStart(4, "0")}.png`);
    await page.screenshot({ path: ssPath, fullPage: true });
    counts.screenshots++;
  } catch (err) {
    await rt("screenshot_error", { error: String(err) });
  }
  try {
    const html = await page.content();
    const domPath = path.join(DOM_DIR, `dom-${String(pollNum).padStart(4, "0")}.html`);
    await writeFile(domPath, html);
    counts.domSnapshots++;
  } catch (err) {
    await rt("dom_snapshot_error", { error: String(err) });
  }

  if (terminalPhase) {
    if (terminalSeenAt === null) terminalSeenAt = Date.now();
    if (Date.now() - terminalSeenAt > SETTLE_MS) {
      await rt("settled_after_terminal", { phase: terminalPhase });
      break;
    }
  }
  if (Date.now() - startedAt > MAX_WAIT_MS) {
    await rt("max_wait_reached", {});
    break;
  }
  await sleep(INTERVAL_MS);
}

// Final summary report.
const lines = [];
lines.push(`# UI watcher report — runId ${RUN_ID}`);
lines.push("");
lines.push(`- web URL: ${WEB_URL}`);
lines.push(`- duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
lines.push(`- terminal phase observed: ${terminalPhase ?? "(none — hit max wait)"}`);
lines.push("");
lines.push(`## Counts`);
for (const [k, v] of Object.entries(counts)) lines.push(`- ${k}: ${v}`);
lines.push("");
lines.push(`## WS event-type breakdown (received)`);
const sortedEv = Object.entries(eventTypeCounts).sort((a, b) => b[1] - a[1]);
for (const [t, n] of sortedEv) lines.push(`- ${t}: ${n}`);
lines.push("");
if (counts.consoleError > 0 || counts.pageErrors > 0) {
  lines.push(`## ⚠ Console errors / page errors`);
  for (const s of consoleSamples) {
    if (s.type === "error" || s.type === "pageerror") {
      lines.push(`- [${s.type}] ${s.text}`);
    }
  }
  lines.push("");
}
lines.push(`## Artifacts`);
lines.push("");
lines.push(`- \`ws-frames-received.jsonl\` — every WS frame the UI received`);
lines.push(`- \`ws-frames-sent.jsonl\` — every WS frame the UI sent`);
lines.push(`- \`console-log.jsonl\` — browser console (log/warn/error/pageerror)`);
lines.push(`- \`network-log.jsonl\` — REST + WS-handshake traffic`);
lines.push(`- \`screenshots/\` — full-page PNG every ${INTERVAL_MS / 1000}s`);
lines.push(`- \`dom/\` — full innerHTML every ${INTERVAL_MS / 1000}s`);
lines.push(`- \`watcher-runtime.jsonl\` — watcher's own diag events`);
await writeFile(SUMMARY_PATH, lines.join("\n") + "\n");

await browser.close();
await rt("watcher_end", { terminalPhase, counts, eventTypeBreakdown: eventTypeCounts });
console.log(`\nui-watcher finished. Report: ${SUMMARY_PATH}`);
