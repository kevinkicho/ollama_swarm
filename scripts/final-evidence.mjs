import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 920 } })).newPage();
  const rid = "7e5a6986-7768-4225-98aa-1f750286484b";
  await page.goto("http://localhost:8244/runs/" + rid, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1400);
  const boxCount = await page.locator("text=/planner.*council|Planners.*council/i").count();
  const asideText = await page.locator("aside").innerText().catch(() => "");
  console.log("planner/council box count:", boxCount);
  console.log("sidebar mentions council group or planner box?", /council group|planner \(council/i.test(asideText));
  console.log("brain id appears raw in sidebar?", /\bid.*brain\b|agent.*brain/i.test(asideText));
  await page.screenshot({ path: "screenshots/verify-final-evidence-live-hybrid.png", fullPage: true });
  await browser.close();
  console.log("Evidence captured.");
})();