import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const rid = process.argv[2];
if (!rid) {
  console.error("Usage: node scripts/temp-capture-hybrid-screenshots.mjs <runId>");
  process.exit(1);
}
const outDir = `screenshots/bugfix-evidence-${Date.now()}`;
fs.mkdirSync(outDir, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForServerReady(port = 8244, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      await new Promise((res, rej) => {
        const req = http.get(`http://localhost:${port}/api/health`, r => { r.resume(); res(); });
        req.on('error', rej);
        req.setTimeout(800, () => req.destroy());
      });
      return true;
    } catch { await sleep(300); }
  }
  return false;
}

(async () => {
  const ready = await waitForServerReady();
  if (!ready) console.log("Warning: server health not confirmed");

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1480, height: 1020 } });
  const page = await ctx.newPage();

  const url = `http://localhost:8244/runs/${rid}`;
  console.log("Navigating to", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(e => console.log("goto err", e.message));
  await sleep(1200);

  // Force close any top dropdowns / run summaries
  for (let i = 0; i < 3; i++) {
    try {
      const btn = page.locator('button[title*="Browse past runs"], button[title*="Run"], [aria-label*="run"]').first();
      if (await btn.isVisible({ timeout: 400 })) {
        await btn.click({ force: true }).catch(() => {});
        await sleep(250);
      }
      await page.keyboard.press('Escape').catch(() => {});
    } catch {}
  }

  // Wait for swarm view content (sidebar or transcript)
  try {
    await page.waitForSelector('aside, .transcript-scroll, text=Planners, text=Drain & Stop, text=Transcript', { timeout: 8000 });
  } catch { console.log("No strong swarm selector yet"); }
  await sleep(800);

  // Ensure transcript tab if possible
  try {
    const txTab = page.locator('button:has-text("Transcript")').first();
    if (await txTab.isVisible({ timeout: 500 })) await txTab.click();
  } catch {}
  await sleep(400);

  // Full page
  await page.screenshot({ path: path.join(outDir, "01-full-run.png"), fullPage: true }).catch(() => {});

  // Sidebar (for buttons, planners, agents, no brain)
  const aside = page.locator("aside").first();
  if (await aside.count() > 0) {
    await aside.screenshot({ path: path.join(outDir, "02-sidebar-buttons-agents.png") }).catch(() => {});
  }

  // Transcript bubbles area
  const txScroll = page.locator(".transcript-scroll, [class*='transcript']").first();
  if (await txScroll.count() > 0) {
    await txScroll.screenshot({ path: path.join(outDir, "03-transcript-bubbles.png") }).catch(() => {});
    // Scroll down a bit for more content
    await txScroll.evaluate(el => { el.scrollTop = Math.max(0, el.scrollHeight * 0.3); }).catch(() => {});
    await sleep(300);
    await txScroll.screenshot({ path: path.join(outDir, "04-transcript-scrolled.png") }).catch(() => {});
  }

  // Try to click "All" filter for full view
  try {
    const allBtn = page.locator('button:has-text("All")').first();
    if (await allBtn.isVisible({ timeout: 600 })) {
      await allBtn.click();
      await sleep(500);
      if (await txScroll.count() > 0) await txScroll.screenshot({ path: path.join(outDir, "05-transcript-all.png") }).catch(() => {});
    }
  } catch {}

  // Root view clean (no dropdown)
  await page.goto("http://localhost:8244/", { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
  await sleep(600);
  try {
    const dd = page.locator('text=Run Summaries').first();
    if (await dd.isVisible({ timeout: 400 })) {
      await page.locator('button[title*="Browse"]').first().click().catch(() => {});
      await sleep(200);
    }
  } catch {}
  await page.screenshot({ path: path.join(outDir, "06-root-clean.png"), fullPage: false }).catch(() => {});

  console.log("Screenshots saved to", outDir);
  await browser.close();
})().catch(e => { console.error("PW script failed", e); process.exit(1); });
