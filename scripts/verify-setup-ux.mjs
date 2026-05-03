// 2026-05-03: one-shot Playwright verification of the SetupForm UX
// changes (UX wins #1-#5 from the setup-form audit). Takes 4
// screenshots covering the key states + scrolls to verify the sticky
// Start CTA. Run via: node scripts/verify-setup-ux.mjs
//
// Output: 4 PNG files in /tmp/setup-ux/ + a console summary of any
// console errors observed during the run.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const URL = process.env.WEB_URL ?? "http://localhost:8244/";
const OUT_DIR = path.join(os.tmpdir(), "setup-ux");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
// Clear localStorage so the "First time?" starter section appears
// (otherwise prior runs of this script may have set the dismissed flag).
const page = await context.newPage();
const consoleMessages = [];
page.on("console", (m) => {
  consoleMessages.push({ type: m.type(), text: m.text() });
});
page.on("pageerror", (err) => {
  consoleMessages.push({ type: "pageerror", text: err.message });
});

await page.goto(URL, { waitUntil: "networkidle" });
// Reset localStorage to baseline + reload
await page.evaluate(() => window.localStorage.clear());
await page.reload({ waitUntil: "networkidle" });

// Wait for the form to render
await page.waitForSelector('[data-testid="setup-form"]', { timeout: 5000 });

// --- Screenshot 1: initial state (starters visible + topology collapsed)
// Use viewport-only (fullPage: false) so the sticky CTA renders at its
// natural position. fullPage: true visually stitches the sticky element
// at viewport-bottom which makes it look like content overlap (it's not).
await page.screenshot({ path: path.join(OUT_DIR, "01-initial.png"), fullPage: false });
console.log(`[1/4] initial-state (viewport-only): ${path.join(OUT_DIR, "01-initial.png")}`);

// --- Screenshot 2: scrolled to bottom — sticky Start CTA should still be visible at bottom
await page.evaluate(() => {
  const form = document.querySelector('[data-testid="setup-form"]');
  if (form) form.scrollIntoView({ block: "end" });
  // Also scroll the parent container to the very bottom
  const scroller = document.querySelector(".h-full.overflow-auto");
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
});
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT_DIR, "02-scrolled-bottom.png"), fullPage: false });
console.log(`[2/4] scrolled-bottom (viewport-only, sticky CTA test): ${path.join(OUT_DIR, "02-scrolled-bottom.png")}`);

// --- Screenshot 3: scroll back to top + dismiss starters via "Don't show again" + reload
await page.evaluate(() => {
  const scroller = document.querySelector(".h-full.overflow-auto");
  if (scroller) scroller.scrollTop = 0;
});
await page.waitForTimeout(200);
const dismissBtn = await page.locator('button:has-text("Don\'t show again")').first();
if (await dismissBtn.count() > 0) {
  await dismissBtn.click();
  await page.waitForTimeout(200);
}
await page.screenshot({ path: path.join(OUT_DIR, "03-starters-dismissed.png"), fullPage: false });
console.log(`[3/4] starters-dismissed (viewport-only): ${path.join(OUT_DIR, "03-starters-dismissed.png")}`);

// --- Screenshot 4: expand Topology grid via "Edit per-agent" button
const editBtn = await page.locator('button:has-text("Edit per-agent")').first();
if (await editBtn.count() > 0) {
  await editBtn.click();
  await page.waitForTimeout(300);
}
// Scroll to topology section so it's actually visible in the viewport
await page.evaluate(() => {
  const headers = Array.from(document.querySelectorAll("h3"));
  const topoHeader = headers.find((h) => h.textContent && h.textContent.toUpperCase().includes("TOPOLOGY"));
  if (topoHeader) topoHeader.scrollIntoView({ block: "start" });
});
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT_DIR, "04-topology-expanded.png"), fullPage: false });
console.log(`[4/4] topology-expanded (viewport-only): ${path.join(OUT_DIR, "04-topology-expanded.png")}`);

// --- Screenshot 5 (UX win #9): textarea auto-resize as the user types
// Type a multi-line directive into the User directive field, screenshot
// to confirm the textarea grew vertically.
const directiveTextarea = await page.locator('textarea').first();
if (await directiveTextarea.count() > 0) {
  await directiveTextarea.fill(
    "Refactor the auth module to use bcrypt instead of MD5.\n\n" +
    "1. Audit every call site of the legacy password-hash function.\n" +
    "2. Propose the migration shape — single big PR vs. incremental file-by-file.\n" +
    "3. Identify regression risks and what tests need to be written.\n" +
    "4. Implement the refactor with backward-compat shims for in-flight sessions.",
  );
  await directiveTextarea.dispatchEvent("input");
  await page.waitForTimeout(200);
  // Scroll the textarea back into view (the User directive field)
  await directiveTextarea.scrollIntoViewIfNeeded();
}
await page.screenshot({ path: path.join(OUT_DIR, "05-textarea-autoresize.png"), fullPage: false });
console.log(`[5/6] textarea-autoresize (UX win #9): ${path.join(OUT_DIR, "05-textarea-autoresize.png")}`);

// --- Screenshot 6 (UX win #7): "Recent runs" chip row.
// Inject 2 fake recent runs into localStorage + reload to render them.
await page.evaluate(() => {
  window.localStorage.setItem(
    "ollama-swarm:recent-runs",
    JSON.stringify({
      entries: [
        {
          id: "r1",
          repoUrl: "https://github.com/sindresorhus/got",
          parentPath: "C:\\users\\you\\projects",
          presetId: "council",
          directiveSnippet: "Audit the README claims against actual code",
          directive: "Audit the README claims against actual code",
          startedAt: Date.now() - 60_000,
        },
        {
          id: "r2",
          repoUrl: "https://github.com/expressjs/express",
          parentPath: "C:\\users\\you\\projects",
          presetId: "blackboard",
          directiveSnippet: "Add input validation to the body-parser middleware",
          directive: "Add input validation to the body-parser middleware",
          startedAt: Date.now() - 600_000,
        },
      ],
    }),
  );
  // Re-show starters too so we can see both first-time + recent at top.
  window.localStorage.removeItem("ollama-swarm:starters-dismissed");
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="setup-form"]', { timeout: 5000 });
await page.screenshot({ path: path.join(OUT_DIR, "06-recent-runs.png"), fullPage: false });
console.log(`[6/6] recent-runs (UX win #7): ${path.join(OUT_DIR, "06-recent-runs.png")}`);

// --- Screenshot 7 (UX win #8): inline preflight — "Resume run" state.
// Force the preflight to return alreadyPresent by typing a parent path
// + repo URL that points to an existing clone. Use this script's own
// repo (ollama_swarm) which definitely exists.
await page.evaluate(() => window.localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="setup-form"]', { timeout: 5000 });
// Use input value as the selector anchor (the form starts with default
// values: kevinkicho repo + C:\users\you\projects parent).
const repoInput = page.locator('input[value^="https://github.com"]').first();
const parentInput = page.locator('input[value^="C:"]').first();
await repoInput.fill("https://github.com/kevinkicho/ollama_swarm");
await parentInput.fill("C:\\Users\\kevin\\Desktop");
// Wait for the 400ms debounce + fetch
await page.waitForTimeout(1500);
// Screenshot 7a: scrolled to TOP — should show the "↻ resume" notice
// in the Repository section.
await page.evaluate(() => {
  const scroller = document.querySelector(".h-full.overflow-auto");
  if (scroller) scroller.scrollTop = 0;
});
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT_DIR, "07a-preflight-resume-top.png"), fullPage: false });
console.log(`[7a] preflight-resume-top (UX win #8): ${path.join(OUT_DIR, "07a-preflight-resume-top.png")}`);
// Screenshot 7b: scrolled to BOTTOM — should show "Resume run" button.
await page.evaluate(() => {
  const scroller = document.querySelector(".h-full.overflow-auto");
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
});
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT_DIR, "07b-preflight-resume-bottom.png"), fullPage: false });
console.log(`[7b] preflight-resume-bottom (UX win #8): ${path.join(OUT_DIR, "07b-preflight-resume-bottom.png")}`);

// --- Screenshot 8 (UX win #11): AI Provider section with provider tabs +
// model select dropdown. Reset to a clean form first.
await page.evaluate(() => window.localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="setup-form"]', { timeout: 5000 });
// Scroll to AI Provider section
await page.evaluate(() => {
  const headers = Array.from(document.querySelectorAll("h3"));
  const aiHeader = headers.find((h) => h.textContent && h.textContent.toUpperCase().includes("AI PROVIDER"));
  if (aiHeader) aiHeader.scrollIntoView({ block: "start" });
});
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT_DIR, "08a-ai-provider-ollama.png"), fullPage: false });
console.log(`[8a] ai-provider-ollama (default): ${path.join(OUT_DIR, "08a-ai-provider-ollama.png")}`);

// Click the Anthropic tab to verify model select switches
const anthropicTab = page.locator('button[role="tab"]:has-text("Anthropic")').first();
if (await anthropicTab.count() > 0 && await anthropicTab.isEnabled()) {
  await anthropicTab.click();
  await page.waitForTimeout(1500); // wait for model discovery
}
await page.screenshot({ path: path.join(OUT_DIR, "08b-ai-provider-anthropic.png"), fullPage: false });
console.log(`[8b] ai-provider-anthropic (after tab click): ${path.join(OUT_DIR, "08b-ai-provider-anthropic.png")}`);

// --- Screenshot 9: User directive label row with DirectiveBadge inline.
// Scrolls to the directive textarea so the new badge position is visible.
await page.evaluate(() => {
  const labels = Array.from(document.querySelectorAll("div"));
  const dirLabel = labels.find((d) =>
    d.textContent && d.textContent.toUpperCase().startsWith("USER DIRECTIVE"),
  );
  if (dirLabel) dirLabel.scrollIntoView({ block: "center" });
});
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT_DIR, "09-directive-badge-inline.png"), fullPage: false });
console.log(`[9] directive-badge-inline: ${path.join(OUT_DIR, "09-directive-badge-inline.png")}`);

// --- Console output summary
const errors = consoleMessages.filter((m) => m.type === "error" || m.type === "pageerror");
const warnings = consoleMessages.filter((m) => m.type === "warning" || m.type === "warn");
console.log("");
console.log(`Console summary: ${consoleMessages.length} total messages (${errors.length} errors, ${warnings.length} warnings)`);
if (errors.length > 0) {
  console.log("ERRORS:");
  for (const m of errors) console.log(`  [${m.type}] ${m.text}`);
}
if (warnings.length > 0) {
  console.log("WARNINGS:");
  for (const m of warnings.slice(0, 5)) console.log(`  [${m.type}] ${m.text}`);
}

await browser.close();
console.log("");
console.log(`Screenshots in: ${OUT_DIR}`);
