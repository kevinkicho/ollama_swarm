import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const outDir = `screenshots/verify-user-issues-${Date.now()}`;
fs.mkdirSync(outDir, { recursive: true });
console.log("Evidence dir:", outDir);

const rid = await (async () => {
  const payload = JSON.stringify({
    preset: "blackboard",
    parentPath: process.cwd(),
    userDirective: "Verify hybrid sidebar fix. agentCount=5 dedicated for 3w+1a extra.",
    useHybridPlanning: true,
    planningPreset: "council",
    agentCount: 5,
    rounds: 1,
    dedicatedAuditor: true,
    plannerModel: "deepseek-v4-flash:cloud",
    workerModel: "deepseek-v4-flash:cloud",
    auditorModel: "deepseek-v4-flash:cloud"
  });
  return new Promise((res) => {
    const req = http.request({ hostname: "127.0.0.1", port: 8243, path: "/api/swarm/start", method: "POST", headers: { "Content-Type": "application/json" } }, (r) => {
      let d = ""; r.on("data", c => d += c); r.on("end", () => res(JSON.parse(d).runId || "unknown"));
    });
    req.write(payload); req.end();
  });
})();

console.log("Started hybrid runId for test:", rid);

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();

await page.goto(`http://localhost:8244/runs/${rid}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(outDir, "01-hybrid-run-live-sidebar.png"), fullPage: true });
console.log("1. Live hybrid sidebar screenshot (should show 3 council boxed planner + ~4 execution: 3w+1a)");

// scroll etc for other issues
const scroller = page.locator("div[class*='overflow']").first();
if (await scroller.count()) {
  await scroller.evaluate(e => e.scrollTop = 200);
}
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, "02-transcript-scrolled.png"), fullPage: true });

// stop for finished
await new Promise(r => { const req=http.request({hostname:"127.0.0.1",port:8243,path:`/api/swarm/runs/${encodeURIComponent(rid)}/stop`,method:"POST"}, () => r()); req.end(); });
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(outDir, "03-finished-hybrid-sidebar.png"), fullPage: true });
console.log("3. Finished hybrid: 3 boxed + summary details for execution agents (4), no dupe planners, shows stats");

await page.goto("http://localhost:8244/", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(outDir, "04-root-setup-clean-no-run-window.png"), fullPage: true });
console.log("4. Root setup clean (ActiveRunsPanel hidden on root per fix)");

await browser.close();
console.log("Verification screenshots done. Check", outDir);
console.log("RunId:", rid);
