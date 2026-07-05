import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const OUT = `screenshots/verify-clean-${Date.now()}`;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();

async function closeRunsDropdownIfOpen() {
  const dropdown = page.locator('text=Run Summaries').first();
  if (await dropdown.isVisible().catch(() => false)) {
    // click the Runs button in topbar to toggle close
    const runsBtn = page.locator('button[title*="Browse past runs"], button:has-text("Runs")').first();
    if (await runsBtn.isVisible().catch(() => false)) {
      await runsBtn.click();
      await page.waitForTimeout(300);
    }
  }
}

console.log('Verifying root clean (no dropdown)');
await page.goto('http://localhost:8244/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await closeRunsDropdownIfOpen();
await page.screenshot({ path: path.join(OUT, '01-root-clean-no-dropdown.png'), fullPage: true });

console.log('Starting a fresh hybrid run for view test');
const payload = JSON.stringify({
  preset: 'blackboard',
  parentPath: process.cwd(),
  userDirective: 'verify clean sidebar screenshot',
  useHybridPlanning: true,
  planningPreset: 'council',
  agentCount: 5,
  dedicatedAuditor: true,
  rounds: 1,
  plannerModel: 'deepseek-v4-flash:cloud',
  workerModel: 'deepseek-v4-flash:cloud'
});
const rid = await new Promise((resolve) => {
  const req = http.request({ hostname: '127.0.0.1', port: 8243, path: '/api/swarm/start', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d).runId));
  });
  req.write(payload); req.end();
});
console.log('Run id:', rid);

await page.goto(`http://localhost:8244/runs/${rid}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await closeRunsDropdownIfOpen();
await page.screenshot({ path: path.join(OUT, '02-runview-clean-sidebar.png'), fullPage: true });

console.log('Stopping run');
await new Promise(r => { const req = http.request({ hostname: '127.0.0.1', port: 8243, path: `/api/swarm/runs/${encodeURIComponent(rid)}/stop`, method: 'POST' }, () => r()); req.end(); });
await page.waitForTimeout(800);
await closeRunsDropdownIfOpen();
await page.screenshot({ path: path.join(OUT, '03-finished-clean.png'), fullPage: true });

await browser.close();
console.log('Clean screenshots saved to', OUT);
console.log('These should now show the sidebar without run dropdown overlay.');
