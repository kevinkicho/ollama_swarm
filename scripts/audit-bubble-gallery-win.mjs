#!/usr/bin/env node
// scripts/audit-bubble-gallery-win.mjs — Windows-host variant of
// audit-bubble-gallery.mjs. The original assumes WSL (`ip route` for the
// Windows host IP, /mnt/c/ output paths). This one runs from git-bash /
// PowerShell against localhost:8244 and writes under runs/.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const baseUrl = "http://localhost:8244/?gallery=1";
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(`runs/_bubble-audit-${ts}`);
fs.mkdirSync(`${outDir}/screenshots`, { recursive: true });

const consoleEntries = [];

async function main() {
  console.log(`Audit target: ${baseUrl}`);
  console.log(`Output dir:   ${outDir}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.on("console", (msg) => consoleEntries.push({ type: msg.type(), text: msg.text() }));
  page.on("pageerror", (err) => consoleEntries.push({ type: "pageerror", text: String(err) }));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await new Promise((r) => setTimeout(r, 2000));

  await page.screenshot({ path: `${outDir}/screenshots/00-gallery-full.png`, fullPage: true });

  const fixtures = await page.$$eval("[data-summary-kind], [data-fixture-id]", (nodes) =>
    nodes.map((n) => ({
      kind: n.getAttribute("data-summary-kind") ?? null,
      id: n.getAttribute("data-fixture-id") ?? null,
      text: (n.textContent ?? "").slice(0, 100).trim(),
    })),
  );

  console.log(`Found ${fixtures.length} elements with data-summary-kind / data-fixture-id`);

  const byKind = new Map();
  for (const f of fixtures) {
    const k = f.kind ?? "(none)";
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }

  let snapped = 0;
  for (const [idx, fixture] of fixtures.entries()) {
    if (snapped >= 40) break;
    const handle = await page.$$(`[data-summary-kind="${fixture.kind}"]`);
    if (handle.length === 0) continue;
    try {
      await handle[Math.min(snapped, handle.length - 1)].scrollIntoViewIfNeeded();
      await new Promise((r) => setTimeout(r, 100));
      const filename = `${String(idx + 1).padStart(2, "0")}-${(fixture.kind ?? "unknown").replace(/[^a-zA-Z0-9_-]+/g, "_")}.png`;
      await page.screenshot({ path: `${outDir}/screenshots/${filename}` });
      snapped += 1;
    } catch {
      // best-effort
    }
  }

  await page.close();
  await context.close();
  await browser.close();

  const errors = consoleEntries.filter((e) => e.type === "error" || e.type === "pageerror");

  const reportLines = [
    `# Bubble-gallery audit — ${ts}`,
    ``,
    `Target: ${baseUrl}`,
    `Total fixture nodes found: ${fixtures.length}`,
    `Per-fixture screenshots: ${snapped}`,
    `Console errors / pageerrors: ${errors.length}`,
    ``,
    `## Coverage by summary.kind`,
    ``,
    `| Kind | Instances |`,
    `| --- | ---: |`,
    ...[...byKind.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, n]) => `| \`${k}\` | ${n} |`),
    ``,
    `## Errors (if any)`,
    ``,
    errors.length === 0
      ? "_No errors._"
      : errors.map((e) => `- **${e.type}** ${e.text}`).join("\n"),
    ``,
    `## Files`,
    ``,
    `- \`screenshots/00-gallery-full.png\` — full-page render`,
    `- \`screenshots/NN-<kind>.png\` — per-fixture viewport snaps`,
    `- \`console.json\` — every console entry captured`,
  ];

  fs.writeFileSync(`${outDir}/REPORT.md`, reportLines.join("\n"));
  fs.writeFileSync(`${outDir}/console.json`, JSON.stringify(consoleEntries, null, 2));

  console.log(`\n${snapped} screenshots, ${errors.length} errors, ${byKind.size} distinct kinds.`);
  console.log(`Report: ${outDir}/REPORT.md`);
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
