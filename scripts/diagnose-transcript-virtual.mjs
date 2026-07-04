#!/usr/bin/env node
// Diagnostic script using Playwright to inspect the virtualized Transcript list.
// - Loads the UI
// - Inspects the virtual container, virtual items' positions, transforms, heights, computed gaps
// - Clicks filters (all, key, agents) and re-inspects to see spacing changes
// - Logs actual pixel gaps between consecutive items vs expected ~4px
// - Captures screenshot and detailed rect data for analysis

import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB_URL = "http://localhost:8244";
const OUT_DIR = path.resolve("runs/_transcript-diagnose-" + new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();

page.on("console", msg => console.log(`[browser] ${msg.type()}: ${msg.text()}`));
page.on("pageerror", err => console.error("[pageerror]", err));

console.log("Navigating to", WEB_URL);
await page.goto(WEB_URL, { waitUntil: "networkidle" }).catch(() => {});
await page.waitForTimeout(3000);

// Helper to inspect virtual items
async function inspectVirtual(label) {
  const data = await page.evaluate(() => {
    const scrollEl = document.querySelector('.overflow-y-auto');
    const virtualContainer = document.querySelector('.overflow-y-auto > div[style*="position: relative"]');
    if (!virtualContainer) return { error: "no virtual container" };

    const items = Array.from(virtualContainer.querySelectorAll('div[style*="position: absolute"]'));
    const rects = items.map((el, i) => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const transform = style.transform;
      const pb = style.paddingBottom;
      return {
        index: i,
        top: r.top,
        height: r.height,
        width: r.width,
        transform,
        paddingBottom: pb,
        textPreview: (el.textContent || "").slice(0, 80).replace(/\s+/g, ' ')
      };
    });

    // Compute gaps between consecutive
    const gaps = [];
    for (let i = 1; i < rects.length; i++) {
      const gap = rects[i].top - (rects[i-1].top + rects[i-1].height);
      gaps.push({ between: i-1, gap: Math.round(gap * 10)/10 });
    }

    const maxGap = Math.max(...gaps.map(g => g.gap));
    const minGap = Math.min(...gaps.map(g => g.gap));
    const avgGap = gaps.length ? gaps.reduce((s,g)=>s+g.gap,0)/gaps.length : 0;

    return {
      virtualContainerHeight: virtualContainer.getBoundingClientRect().height,
      numVirtualItems: items.length,
      gaps: gaps.slice(0, 10), // first few
      stats: { minGap, maxGap, avgGap: Math.round(avgGap*10)/10, numGaps: gaps.length },
      firstFewRects: rects.slice(0, 5),
      lastFewRects: rects.slice(-5)
    };
  });

  const outPath = path.join(OUT_DIR, `inspect-${label}.json`);
  await writeFile(outPath, JSON.stringify(data, null, 2));
  console.log(`[${label}]`, JSON.stringify(data.stats || data, null, 0));
  return data;
}

// Initial
await inspectVirtual("initial");

// Try switching filters
const filters = ["all", "key", "agents", "system"];
for (const f of filters) {
  try {
    const btn = await page.$(`button:has-text("${f === "key" ? "Key" : f.charAt(0).toUpperCase() + f.slice(1)}")`);
    if (btn) {
      await btn.click();
      await page.waitForTimeout(800);
      await inspectVirtual(`filter-${f}`);
    }
  } catch (e) {
    console.log("filter click issue", f, e.message);
  }
}

// Screenshot
await page.screenshot({ path: path.join(OUT_DIR, "transcript-current.png"), fullPage: true });
console.log("screenshot saved");

await browser.close();
console.log("Diagnosis complete. Output in", OUT_DIR);