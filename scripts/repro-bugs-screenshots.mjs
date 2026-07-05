import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const rid = process.argv[2] || "b2900032-df1a-494d-ad73-deb173ab8098";
const out = `screenshots/bug-repro-${Date.now()}`;
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();

await page.goto(`http://localhost:8244/runs/${rid}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

// Bug1: sidebar stop buttons
await page.screenshot({ path: path.join(out, "01-sidebar-stop-buttons.png"), clip: { x: 0, y: 0, width: 320, height: 450 } });
console.log("01: sidebar for stop/drain buttons");

// Bug2/3: full transcript
await page.screenshot({ path: path.join(out, "02-full-transcript.png"), fullPage: true });
console.log("02: full for jitter/gaps");

// Scroll and capture gaps
const scroller = page.locator(".transcript-scroll").first();
if (await scroller.count() > 0) {
  await scroller.evaluate(el => { el.scrollTop = 300; });
  await page.waitForTimeout(400);
}
await page.screenshot({ path: path.join(out, "03-scrolled-gaps.png"), fullPage: true });
console.log("03: scrolled gaps");

// Check for brain in transcript
const brainCount = await page.locator("text=Brain, [class*='brain']").count();
console.log("Brain mentions in page:", brainCount);

await browser.close();
console.log("Screenshots in", out);
console.log("Now research/fix code.");
