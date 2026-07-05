import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const summaryPath = "logs/summary-f3290ac3-2026-07-05T04-06-41-862Z.json";
const backup = summaryPath + ".bak";

async function main() {
  // backup + patch
  if (fs.existsSync(summaryPath)) {
    fs.copyFileSync(summaryPath, backup);
    const j = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    j.useHybridPlanning = true;
    j.planningPreset = "council";
    if (!j.runConfig) j.runConfig = {};
    j.runConfig.useHybridPlanning = true;
    j.runConfig.planningPreset = "council";
    j.runConfig.preset = j.preset || "blackboard";
    fs.writeFileSync(summaryPath, JSON.stringify(j, null, 2));
    console.log("Patched summary with hybrid flags for UI test.");
  }

  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();

  // Load the patched hybrid run
  await page.goto("http://localhost:8244/runs/f3290ac3-aed2-47ad-9095-f943302a14db", { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);

  // Screenshot full to capture sidebar planners group + transcript
  await page.screenshot({ path: "screenshots/verify-hybrid-council-planners-sidebar.png", fullPage: true });
  console.log("Captured verify-hybrid-council-planners-sidebar.png");

  // Scroll a bit and capture for gaps/sticky test
  await page.evaluate(() => {
    const els = document.querySelectorAll("div");
    for (const el of els) {
      if (el.scrollHeight > el.clientHeight && el.clientHeight > 200) { el.scrollTop = 180; break; }
    }
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "screenshots/verify-hybrid-transcript-scrolled.png", fullPage: true });

  // Try Latest
  const latest = page.locator('button:has-text("Latest")');
  if (await latest.count() > 0) {
    await latest.click().catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: "screenshots/verify-hybrid-latest.png", fullPage: true });

  await browser.close();

  // revert file
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, summaryPath);
    fs.unlinkSync(backup);
    console.log("Reverted summary patch.");
  }
  console.log("Done. Check screenshots for the boxed planners.");
}
main().catch(console.error);