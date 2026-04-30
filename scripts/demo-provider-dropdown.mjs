#!/usr/bin/env node
// scripts/demo-provider-dropdown.mjs — 90-second Playwright demo of the
// new multi-provider SetupForm UI. Records a webm video + per-step
// screenshots. Read-only: never clicks Start.
//
// Run: node scripts/demo-provider-dropdown.mjs
//
// Output (printed at end):
//   <out>/video/page@*.webm        full session recording (~90s)
//   <out>/screenshots/NN-*.png     ~10 screenshots of key states

import { chromium } from "playwright";
import fs from "node:fs";
import { execSync } from "node:child_process";

const winHost = execSync("ip route | awk '/^default/ {print $3}'").toString().trim();
const baseUrl = `http://${winHost}:8244/`;
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = `/mnt/c/Users/kevin/Desktop/ollama_swarm/runs/_demo-providers-${ts}`;
fs.mkdirSync(`${outDir}/screenshots`, { recursive: true });
fs.mkdirSync(`${outDir}/video`, { recursive: true });

const consoleEntries = [];
let stepIdx = 0;

async function snap(page, label) {
  stepIdx += 1;
  const filename = `${String(stepIdx).padStart(2, "0")}-${label.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 50)}.png`;
  await page.screenshot({ path: `${outDir}/screenshots/${filename}`, fullPage: false });
  console.log(`  snap ${filename}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Demo target: ${baseUrl}`);
  console.log(`Output dir:  ${outDir}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    recordVideo: { dir: `${outDir}/video`, size: { width: 1280, height: 900 } },
  });
  const page = await context.newPage();
  page.on("console", (msg) => consoleEntries.push({ type: msg.type(), text: msg.text() }));
  page.on("pageerror", (err) => consoleEntries.push({ type: "pageerror", text: String(err) }));

  // 0-5s: Load page and let the SetupForm settle
  console.log("[0–5s] Loading SetupForm…");
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await sleep(2000);
  // Scroll to the Run section so the Provider dropdown is in view
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("h2, h3, label, div")].find((n) =>
      n.textContent?.trim().startsWith("Run"),
    );
    if (el) el.scrollIntoView({ block: "center" });
  });
  await sleep(2000);
  await snap(page, "01-initial-state-ollama");

  // 5-15s: Click the Provider dropdown to reveal options
  console.log("[5–15s] Opening Provider dropdown…");
  const providerSelect = page.locator('select[aria-label="Provider"]');
  await providerSelect.scrollIntoViewIfNeeded();
  await sleep(1500);
  await snap(page, "02-provider-dropdown-closed");
  // Native <select> options aren't always visible in screenshots; we
  // verify by reading the option text instead.
  const optionTexts = await providerSelect.locator("option").allInnerTexts();
  console.log("  Provider options:", optionTexts);
  await sleep(2500);

  // 15-30s: Switch to Anthropic — model autocomplete should change
  console.log("[15–30s] Switching to Anthropic…");
  await providerSelect.selectOption("anthropic");
  await sleep(2000);
  await snap(page, "03-anthropic-selected-cost-field-appears");
  // Verify: max-cost field becomes visible
  const costField = page.locator('input[placeholder*="0.50"]');
  const costVisible = await costField.isVisible().catch(() => false);
  console.log("  Max-cost field visible:", costVisible);
  await sleep(2500);

  // Type into the Model field to demonstrate Claude-model autocomplete
  console.log("[Model field] Showing Anthropic model list…");
  const modelInput = page.locator('input[aria-label="Default model"]').first();
  await modelInput.click();
  await modelInput.fill("");
  await sleep(800);
  await modelInput.type("anthropic/claude", { delay: 80 });
  await sleep(2500);
  await snap(page, "04-anthropic-model-autocomplete");

  // Type the cost cap so it's visible
  await costField.click();
  await costField.fill("0.50");
  await sleep(1500);
  await snap(page, "05-cost-cap-set-to-50c");

  // 30-50s: Switch to OpenAI
  console.log("[30–50s] Switching to OpenAI…");
  await providerSelect.selectOption("openai");
  await sleep(2000);
  await modelInput.click();
  await modelInput.fill("");
  await modelInput.type("openai/gpt", { delay: 80 });
  await sleep(2500);
  await snap(page, "06-openai-model-autocomplete");

  // 50-70s: Switch back to Ollama — cost field hides, Ollama models
  console.log("[50–70s] Switching back to Ollama…");
  await providerSelect.selectOption("ollama");
  await sleep(2000);
  const costStillVisible = await costField.isVisible().catch(() => false);
  console.log("  Max-cost field hidden after Ollama switch:", !costStillVisible);
  await snap(page, "07-back-to-ollama-cost-hidden");

  // 70-90s: Show the rest of the form so the demo isn't just one section
  console.log("[70–90s] Pan through the form…");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await sleep(2500);
  await snap(page, "08-top-of-form");
  await page.evaluate(() => window.scrollTo({ top: 400, behavior: "smooth" }));
  await sleep(2500);
  await snap(page, "09-mid-form");
  await page.evaluate(() => window.scrollTo({ top: 1200, behavior: "smooth" }));
  await sleep(2500);
  await snap(page, "10-run-section-final");

  console.log("\n[done] Closing browser…");
  await page.close();
  await context.close();
  await browser.close();

  // Summary file
  fs.writeFileSync(`${outDir}/console.json`, JSON.stringify(consoleEntries, null, 2));
  fs.writeFileSync(
    `${outDir}/REPORT.md`,
    [
      `# Provider-dropdown demo — ${ts}`,
      ``,
      `Target: ${baseUrl}`,
      `Steps captured: ${stepIdx}`,
      `Console errors: ${consoleEntries.filter((e) => e.type === "error" || e.type === "pageerror").length}`,
      ``,
      `## Screenshots`,
      ...fs.readdirSync(`${outDir}/screenshots`).sort().map((f) => `- ${f}`),
      ``,
      `## Video`,
      ...fs.readdirSync(`${outDir}/video`).sort().map((f) => `- video/${f}`),
    ].join("\n"),
  );
  console.log(`\nReport: ${outDir}/REPORT.md`);
  console.log(`Video:  ${outDir}/video/`);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
