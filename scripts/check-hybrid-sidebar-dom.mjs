import fs from "node:fs";
import { chromium } from "playwright";

const f = "logs/summary-f3290ac3-2026-07-05T04-06-41-862Z.json";
const bak = f + ".dombak";

async function run() {
  fs.copyFileSync(f, bak);
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.useHybridPlanning = true;
  j.planningPreset = "council";
  j.runConfig = j.runConfig || {};
  j.runConfig.useHybridPlanning = true;
  j.runConfig.planningPreset = "council";
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
  console.log("[check] patched");

  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 940 } })).newPage();
  await page.goto("http://localhost:8244/runs/f3290ac3-aed2-47ad-9095-f943302a14db", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);

  const boxCount = await page.locator('text=planner (council 3 agents collectively)').count();
  const brainCount = await page.locator('text=/\\bbrain\\b/i').count();
  const sidebarText = await page.locator("aside").innerText().catch(() => "");
  console.log("[check] planner-box count:", boxCount);
  console.log("[check] brain mentions in page:", brainCount);
  console.log("[check] sidebar sample includes planners?", /planner.*council/i.test(sidebarText));

  await page.screenshot({ path: "screenshots/verify-hybrid-dom-check.png", fullPage: true });

  await browser.close();

  fs.copyFileSync(bak, f);
  fs.unlinkSync(bak);
  console.log("[check] reverted. evidence png written.");
}
run().catch(e => { console.error(e); process.exit(1); });