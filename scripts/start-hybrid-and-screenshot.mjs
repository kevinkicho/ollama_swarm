import http from "node:http";
import { chromium } from "playwright";
import fs from "node:fs";

const cwd = process.cwd();

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1", port: 8243, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

async function main() {
  console.log("[start] starting hybrid run...");
  const startResp = await postJson("/api/swarm/start", {
    preset: "blackboard",
    parentPath: cwd,
    userDirective: "Verify UI. Make a trivial comment edit only.",
    useHybridPlanning: true,
    planningPreset: "council",
    agentCount: 3,
    rounds: 1,
    plannerModel: "deepseek-v4-flash:cloud",
    workerModel: "deepseek-v4-flash:cloud",
  });
  console.log("[start] resp", startResp.status, startResp.body);
  let runId;
  try { runId = JSON.parse(startResp.body).runId; } catch {}
  if (!runId) { console.log("no runId"); process.exit(1); }
  console.log("[start] got runId", runId);

  // poll status briefly for runConfig in status
  await new Promise(r => setTimeout(r, 1200));
  const statusUrl = `/api/swarm/runs/${encodeURIComponent(runId)}/status`;
  const statusP = await new Promise(res => http.get("http://127.0.0.1:8243" + statusUrl, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>res({s:r.statusCode,b:d})); }));
  console.log("[status] ", statusP.s, statusP.b.slice(0,200));

  // now playwright to the run view immediately (tests no delay + sidebar)
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 960 } })).newPage();
  const t0 = Date.now();
  await page.goto(`http://localhost:8244/runs/${runId}`, { waitUntil: "domcontentloaded" });
  const loadMs = Date.now() - t0;
  console.log("[ui] navigated to run view in", loadMs, "ms");
  await page.waitForTimeout(900);
  await page.screenshot({ path: "screenshots/verify-live-hybrid-start.png", fullPage: true });

  // stop it
  await postJson(`/api/swarm/runs/${encodeURIComponent(runId)}/stop`, {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: "screenshots/verify-live-hybrid-stopped.png", fullPage: true });

  // check DOM for sidebar content
  const asideText = await page.locator("aside").innerText().catch(()=> "");
  console.log("[ui] sidebar contains 'planner (council' ?", /planner.*council/i.test(asideText));
  console.log("[ui] sidebar contains 'brain' (should be filtered)?", /\bbrain\b/i.test(asideText));

  await browser.close();
  console.log("[done] screenshots + checks for live hybrid run complete.");
}
main().catch(e => { console.error(e); process.exit(1); });