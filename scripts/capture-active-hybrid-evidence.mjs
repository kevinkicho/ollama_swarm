import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const OUT_BASE = `screenshots/bugfix-active-${Date.now()}`;
fs.mkdirSync(OUT_BASE, { recursive: true });

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

function getJson(port, pth) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pth }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy());
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const port = 8244;
  console.log("Starting hybrid via API...");
  const startBody = {
    preset: "blackboard",
    parentPath: process.cwd(),
    userDirective: "active hybrid repro: council 3 planners + exec agents + visible Drain&Stop during discussing + tight transcript bubbles + no brain",
    useHybridPlanning: true,
    planningPreset: "council",
    executionPreset: "blackboard",
    agentCount: 5,
    dedicatedAuditor: true,
    rounds: 1,
    model: "deepseek-v4-flash:cloud"
  };
  let rid;
  try {
    const s = await postJson(port, "/api/swarm/start", startBody);
    rid = s.runId;
  } catch (e) { console.error("start failed", e.message); process.exit(1); }
  console.log("rid=", rid);

  // Poll until we see discussing or agents appear (up to ~12s)
  let active = false;
  for (let i = 0; i < 25; i++) {
    try {
      const st = await getJson(port, "/api/swarm/status");
      if (st && (st.phase === "discussing" || (st.agents && st.agents.length > 0))) {
        console.log("active state:", st.phase, "agents:", (st.agents||[]).length);
        active = true;
        break;
      }
    } catch {}
    await sleep(450);
  }
  if (!active) console.log("proceeding even if not yet 'discussing'");

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1020 } });
  const page = await ctx.newPage();

  // Go to root first to have the queue, then open the specific run
  await page.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await sleep(800);

  // Close any open dropdowns
  for (let i = 0; i < 3; i++) {
    try { await page.keyboard.press("Escape"); } catch {}
    try {
      const btn = page.locator('button[title*="Browse past runs"]').first();
      if (await btn.isVisible({ timeout: 300 })) await btn.click().catch(() => {});
    } catch {}
    await sleep(150);
  }

  // Find the row for this rid (short prefix) and click its View
  const short = rid.slice(0, 8);
  let opened = false;
  try {
    const row = page.locator(`text=${short}`).first().locator("xpath=ancestor::li | ancestor::div[contains(@class,'run') or contains(@class,'queue')]").first();
    const viewBtn = row.locator('text=View').first();
    if (await viewBtn.isVisible({ timeout: 1500 })) {
      await viewBtn.click();
      opened = true;
      await sleep(800);
    }
  } catch {}

  if (!opened) {
    // fallback direct
    await page.goto(`http://localhost:${port}/runs/${rid}`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await sleep(800);
  }

  // Wait for inner run content indicators (the SwarmView agents header or buttons)
  try {
    await page.waitForSelector('text=/Drain & Stop|Planners \\(council|planner \\(council|Stop/i', { timeout: 6000 });
  } catch {
    console.log("no direct button/planner text found in time; will capture what is there");
  }
  await sleep(400);

  // Ensure transcript tab
  try { await page.locator('button:has-text("Transcript")').first().click({ timeout: 500 }); await sleep(200); } catch {}

  // Click "All" for full transcript
  try { await page.locator('button:has-text("All")').first().click({ timeout: 500 }); await sleep(250); } catch {}

  // Take evidence
  await page.screenshot({ path: path.join(OUT_BASE, "01-full.png"), fullPage: true }).catch(() => {});

  // The inner agents sidebar: prefer the one containing planners or the stop buttons
  const agentsPane = page.locator('aside:has-text("Planners"), aside:has-text("Drain"), aside.w-\\[280px\\]').first();
  if (await agentsPane.count() > 0) {
    await agentsPane.screenshot({ path: path.join(OUT_BASE, "02-agents-sidebar.png") }).catch(() => {});
  } else {
    // fallback any aside that looks like the run agents
    const any = page.locator("aside").nth(1);
    if (await any.count() > 0) await any.screenshot({ path: path.join(OUT_BASE, "02-agents-sidebar-fallback.png") }).catch(() => {});
  }

  // Transcript bubbles
  const txArea = page.locator(".transcript-scroll, [class*='transcript']").first();
  if (await txArea.count() > 0) {
    await txArea.screenshot({ path: path.join(OUT_BASE, "03-transcript-bubbles.png") }).catch(() => {});
    // scroll and another
    await txArea.evaluate(el => { if (el) el.scrollTop = Math.min(400, el.scrollHeight / 3); }).catch(() => {});
    await sleep(200);
    await txArea.screenshot({ path: path.join(OUT_BASE, "04-transcript-scrolled.png") }).catch(() => {});
  }

  // Objective queries (scoped as much as possible)
  const drainCount = await page.locator('text=Drain & Stop').count();
  const stopCount = await page.locator('button:has-text("Stop"), text="Stop"').count();
  const plannersCount = await page.locator('text=/planner \\(council|Planners \\(council/i').count();
  const brainInRunArea = await page.locator('aside, [class*="agent"], [class*="sidebar"]').locator('text=/\\bbrain\\b/i').count().catch(() => 0);
  console.log(JSON.stringify({ drainCount, stopCount, plannersCount, brainInRunArea, rid, out: OUT_BASE }));

  // Also a clean root shot
  await page.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(400);
  try {
    const dd = page.locator('text=Run Summaries').first();
    if (await dd.isVisible({ timeout: 300 })) {
      await page.locator('button[title*="Browse"]').first().click().catch(() => {});
      await sleep(150);
    }
  } catch {}
  await page.screenshot({ path: path.join(OUT_BASE, "05-root.png") }).catch(() => {});

  console.log("Evidence saved to", OUT_BASE);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
