import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const OUT = `screenshots/verify-hybrid-agents-fixed-${Date.now()}`;
fs.mkdirSync(OUT, { recursive: true });

async function startHybrid(agentCount = 5) {
  const payload = JSON.stringify({
    preset: "blackboard",
    parentPath: process.cwd(),
    userDirective: "verify full team: 3 council + execution workers+auditor",
    useHybridPlanning: true,
    planningPreset: "council",
    agentCount,
    dedicatedAuditor: true,
    rounds: 1,
    plannerModel: "deepseek-v4-flash:cloud",
    workerModel: "deepseek-v4-flash:cloud",
    auditorModel: "deepseek-v4-flash:cloud"
  });
  return new Promise((resolve) => {
    const req = http.request({ hostname: "127.0.0.1", port: 8243, path: "/api/swarm/start", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d).runId));
    });
    req.write(payload); req.end();
  });
}

async function stopRun(rid) {
  return new Promise((r) => {
    const req = http.request({ hostname: "127.0.0.1", port: 8243, path: `/api/swarm/runs/${encodeURIComponent(rid)}/stop`, method: "POST" }, () => r());
    req.end();
  });
}

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();

async function closeDropdown() {
  const content = page.locator('text=Run Summaries').first();
  if (await content.isVisible().catch(() => false)) {
    const btn = page.locator('button[title*="Browse past runs"]').first();
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await page.waitForTimeout(200);
  }
}

console.log("Start hybrid with agentCount=5");
const rid = await startHybrid(5);
console.log("rid", rid);

await page.goto(`http://localhost:8244/runs/${rid}`, { waitUntil: "domcontentloaded" });

// wait for execution phase by polling transcript or status for blackboard or more agents
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const txt = await page.locator('body').innerText().catch(() => "");
  if (txt.includes("blackboard") && txt.includes("phase") || (txt.match(/agent-/g) || []).length > 4) {
    console.log("Execution phase detected or enough agents");
    break;
  }
}

await closeDropdown();
await page.screenshot({ path: path.join(OUT, "01-runtime-hybrid-5-agents.png"), fullPage: true });
console.log("Screenshot 01: should show 3 boxed + 4+ execution agents");

await stopRun(rid);
await page.waitForTimeout(1500);
await closeDropdown();
await page.screenshot({ path: path.join(OUT, "02-finished-hybrid-5-agents.png"), fullPage: true });
console.log("Screenshot 02: finished, box + summary with details for execution agents");

await browser.close();
console.log("Done. Check", OUT);
