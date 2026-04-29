#!/usr/bin/env node
// scripts/audit-bubble-gallery.mjs — render the BubbleGallery route at
// /?gallery=1, screenshot every fixture, count console errors, write a
// REPORT.md. Used to catch regressions in summary.kind rendering after
// changes to surrounding code (the 2026-04-29 multi-provider work
// didn't touch bubble code, but this re-confirms).
//
// Faster + more deterministic than spinning a real swarm run because
// the fixtures are hand-crafted snapshots of every summary.kind shape.

import { chromium } from "playwright";
import fs from "node:fs";
import { execSync } from "node:child_process";

const winHost = execSync("ip route | awk '/^default/ {print $3}'").toString().trim();
const baseUrl = `http://${winHost}:8244/?gallery=1`;
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = `/mnt/c/Users/kevin/Desktop/ollama_swarm/runs/_bubble-audit-${ts}`;
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
  // Give React + datalist hydration time to settle
  await new Promise((r) => setTimeout(r, 2000));

  // Full-page screenshot of the entire gallery
  await page.screenshot({ path: `${outDir}/screenshots/00-gallery-full.png`, fullPage: true });

  // Enumerate every fixture wrapper. The gallery is built around named
  // section headers; we screenshot the viewport at each.
  const fixtures = await page.$$eval("[data-summary-kind], [data-fixture-id]", (nodes) =>
    nodes.map((n) => ({
      kind: n.getAttribute("data-summary-kind") ?? null,
      id: n.getAttribute("data-fixture-id") ?? null,
      text: (n.textContent ?? "").slice(0, 100).trim(),
    })),
  );

  console.log(`Found ${fixtures.length} elements with data-summary-kind / data-fixture-id`);

  // Group by kind to know coverage
  const byKind = new Map();
  for (const f of fixtures) {
    const k = f.kind ?? "(none)";
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }

  // Per-fixture viewport screenshots — scroll to each, snap. Bound to
  // first 40 to keep the audit fast; gallery has ~34 fixtures total.
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
      // best-effort; some fixtures might not be addressable
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
