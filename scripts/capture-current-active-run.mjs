import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const rid = process.argv[2] || "b6369f2f-7713-4970-91d4-57cd0b70914f";
const out = `screenshots/active-${rid.slice(0,8)}-${Date.now()}`;
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1520, height: 1050 } });
  const page = await ctx.newPage();

  console.log("Loading run", rid);
  const port = process.env.PORT || '8243'; await page.goto(`http://localhost:${port}/runs/${rid}`, { waitUntil: "networkidle", timeout: 20000 }).catch(e => console.log("goto warn", e.message));
  await page.waitForTimeout(1200);

  // Aggressively close any top dropdown / run summaries
  for (let i = 0; i < 4; i++) {
    try {
      await page.keyboard.press("Escape").catch(() => {});
      const btn = page.locator('button[title*="Browse past runs"], button:has-text("Run Summaries")').first();
      if (await btn.isVisible({ timeout: 250 })) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(200);
      }
    } catch {}
  }

  // Wait for the inner run content to appear (the agents sidebar with buttons or planners)
  try {
    await page.waitForSelector('text=/Drain & Stop|planner \\(council|Planners \\(council|Stop/i', { timeout: 8000 });
  } catch {
    console.log("Timeout waiting for inner controls text - capturing anyway");
  }
  await page.waitForTimeout(600);

  // Make sure we are on Transcript tab
  try {
    await page.locator('button:has-text("Transcript")').first().click({ timeout: 800 });
    await page.waitForTimeout(300);
  } catch {}

  // Switch to All filter for full transcript
  try {
    await page.locator('button:has-text("All")').first().click({ timeout: 600 });
    await page.waitForTimeout(400);
  } catch {}

  // === Full page ===
  await page.screenshot({ path: path.join(out, "01-full.png"), fullPage: true });

  // === Target the correct inner agents sidebar (the w-[280px] one with the run controls) ===
  // Prefer the aside that contains the stop buttons or the council planner text
  let sidebar = page.locator('aside:has-text("Drain & Stop"), aside:has-text("planner (council"), aside.w-\\[280px\\]').first();
  if (await sidebar.count() === 0) {
    // fallback: the first aside after the main content area that looks like agents
    sidebar = page.locator('aside').nth(1);
  }
  if (await sidebar.count() > 0) {
    await sidebar.screenshot({ path: path.join(out, "02-agents-sidebar.png") });
  }

  // === Transcript bubbles area ===
  const tx = page.locator('.transcript-scroll, [class*="transcript"]').first();
  if (await tx.count() > 0) {
    await tx.screenshot({ path: path.join(out, "03-transcript.png") });
    // scroll a bit for more bubbles
    await tx.evaluate(el => { el.scrollTop = Math.max(100, el.scrollHeight * 0.25); }).catch(() => {});
    await page.waitForTimeout(300);
    await tx.screenshot({ path: path.join(out, "04-transcript-scrolled.png") });
  }

  // === Objective queries ===
  const hasDrain = await page.locator('text=Drain & Stop').count();
  const hasStop = (await page.locator('text=Stop').count()) + (await page.locator('button:has-text("Stop")').count());
  const hasPlanners = await page.locator('text=/planner \\(council 3|Planners \\(council group/i').count();
  const brainInSidebar = await page.locator('aside').locator('text=/\\bbrain\\b/i').count().catch(() => 0);
  const agentPanels = await page.locator('aside [class*="AgentPanel"], aside .rounded').count().catch(() => 0);

  console.log("COUNTS:", JSON.stringify({ hasDrain, hasStop, hasPlanners, brainInSidebar, agentPanels }));

  // Also capture the header area specifically if possible
  const header = page.locator('aside .flex.items-center.justify-between').first();
  if (await header.count() > 0) {
    await header.screenshot({ path: path.join(out, "05-buttons-header.png") });
  }

  await browser.close();
  console.log("Screenshots in", out);
})();
