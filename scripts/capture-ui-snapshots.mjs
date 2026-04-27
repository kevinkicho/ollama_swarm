#!/usr/bin/env node
// Open the swarm UI in a Playwright browser, take screenshots + DOM
// snapshots of the transcript at run end. Targets issue #4 in the
// blackboard issues investigation: WebUI bubble routing.
//
// Usage (after a swarm run completes):
//   node scripts/capture-ui-snapshots.mjs --runDir=runs/_monitor/<runId>
//
// What it captures:
//   - full-page screenshot (transcript + agent panels)
//   - per-bubble HTML snapshot — every .transcript-entry / [data-kind] node
//   - text content of each bubble — to compare against summary.transcript[]
//
// Args:
//   --webUrl    UI base URL (default http://localhost:8244)
//   --runDir    where to write screenshots + bubble-snapshots.json
//   --waitMs    how long to wait after navigation before capturing (default 5000)

import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const WEB_URL = args.webUrl ?? "http://localhost:8244";
const RUN_DIR = args.runDir;
const WAIT_MS = Number(args.waitMs ?? 5000);

if (!RUN_DIR) {
  console.error("--runDir=<path> is required");
  process.exit(2);
}

const RUN_DIR_ABS = path.resolve(RUN_DIR);
if (!existsSync(RUN_DIR_ABS)) await mkdir(RUN_DIR_ABS, { recursive: true });

const SCREENSHOT_PATH = path.join(RUN_DIR_ABS, "ui-screenshot.png");
const BUBBLES_PATH = path.join(RUN_DIR_ABS, "ui-bubbles.json");
const PAGE_HTML_PATH = path.join(RUN_DIR_ABS, "ui-page.html");

console.log(`opening ${WEB_URL}`);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page = await ctx.newPage();
page.on("console", (msg) => console.log(`[browser ${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => console.log(`[browser error] ${err.message}`));

await page.goto(WEB_URL, { waitUntil: "networkidle" });
await page.waitForTimeout(WAIT_MS);

// Capture every transcript-entry-like element. We don't know the exact
// selectors used by the React tree, so cast a wide net and the analyst
// can grep the JSON for what's missing.
const bubbles = await page.evaluate(() => {
  // Try several plausible selectors; the renderer may use any of them.
  const selectors = [
    "[data-entry-id]",
    "[data-kind]",
    ".transcript-entry",
    ".message-bubble",
    "[class*=Bubble]",
    "[class*=bubble]",
    "article", // common semantic for transcript entries
  ];
  const seen = new Set();
  const out = [];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      out.push({
        selector: sel,
        tag: el.tagName,
        classes: el.className?.toString?.() ?? "",
        dataset: { ...el.dataset },
        textContent: (el.textContent ?? "").slice(0, 800),
        innerHTML: el.innerHTML?.slice?.(0, 1500) ?? "",
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      });
    }
  }
  return out;
});

await writeFile(BUBBLES_PATH, JSON.stringify(bubbles, null, 2));
console.log(`captured ${bubbles.length} bubble-like elements → ${BUBBLES_PATH}`);

const html = await page.content();
await writeFile(PAGE_HTML_PATH, html);
console.log(`page HTML → ${PAGE_HTML_PATH}`);

await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
console.log(`screenshot → ${SCREENSHOT_PATH}`);

await browser.close();
console.log("done");
