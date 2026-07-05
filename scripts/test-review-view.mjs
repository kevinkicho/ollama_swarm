import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const rid = "cec247b4-a78e-4d4a-8edf-6d4311776f96";
const clone = "C:\\Users\\ysile\\Downloads\\workspace\\ollama_swarm";
const url = `http://localhost:8244/?review=${rid}&path=${encodeURIComponent(clone)}`;

console.log("Testing review URL:", url);

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

const hasBox = await page.locator('text=planner (council|PLANNERS (COUNCIL').count() > 0;
const hasTranscript = await page.locator('text=Transcript, .transcript-scroll').count() > 0;
const hasEntries = await page.locator('text=Pipeline, text=agents ready, text=seed').count() > 0;
const mainContent = await page.locator('section.flex-1, main, [class*="flex-1 min-h-0"]').first().innerText().catch(() => "");
const bodyText = await page.locator('body').innerText().catch(() => "");

console.log("Has planner box:", hasBox);
console.log("Has transcript area:", hasTranscript);
console.log("Has entries visible:", hasEntries);
console.log("Main content length:", mainContent.length);
console.log("Sample main:", mainContent.substring(0, 300));

const out = `screenshots/review-cec247b4-test-${Date.now()}.png`;
await page.screenshot({ path: out, fullPage: true });
console.log("Screenshot:", out);

await browser.close();

if (hasBox && hasTranscript && hasEntries) {
  console.log("SUCCESS: review view now shows content (box + transcript entries)");
} else {
  console.log("Still issues - check the screenshot");
}
