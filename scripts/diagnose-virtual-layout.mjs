#!/usr/bin/env node
// Self-contained Playwright diagnosis of virtual list layout (no backend needed).
// Replicates the key structure from Transcript.tsx:
// - scroll container with padding
// - relative div with height from getTotalSize
// - absolute children with transformY(start) + paddingBottom:4px
// - inner content with varying heights (simulating bubbles, tall grids, text)
// Runs in browser, computes actual rendered gaps between items, reports if consistent ~4px or staggered (varying > tolerance or overlaps).

import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve("runs/_virtual-layout-diag-" + Date.now());
await import("node:fs/promises").then(fs => fs.mkdir(OUT, {recursive:true}));

const html = `<!doctype html>
<html><body style="margin:0;font-family:sans-serif">
<div id="scroll" style="height:400px; overflow-y:auto; padding:16px; background:#111; color:#eee; border:1px solid #333;">
  <div id="virt" style="height: VAR_TOTAL; width:100%; position:relative; background:rgba(255,255,255,0.03);">
    <!-- items injected by script -->
  </div>
  <div style="height:60px;background:#222;">[tail / dock simulation]</div>
</div>
<script>
  // Simulate the virtual items with varying heights like real bubbles + tall summary
  const items = [
    {h: 80, label: 'agent short'},
    {h: 140, label: 'agent med text'},
    {h: 320, label: 'run_finished tall grid (6 agents)'}, // the problematic one
    {h: 95, label: 'deliverable'},
    {h: 55, label: 'system'},
    {h: 200, label: 'agent long response'},
    {h: 70, label: 'agent'},
  ];
  let y = 0;
  const GAP = 4;
  const container = document.getElementById('virt');
  const results = [];
  items.forEach((it, idx) => {
    const outer = document.createElement('div');
    outer.style.cssText = \`position:absolute; top:0; left:0; width:100%; transform:translateY(\${y}px); box-sizing:border-box;\`;
    const inner = document.createElement('div');
    inner.style.cssText = \`padding-bottom:\${GAP}px;\`;
    inner.innerHTML = \`<div style="background:#\${idx%2?'334':'445'}; padding:8px; border:1px solid #666; min-height:\${it.h}px; font-size:12px;">\${it.label} (h=\${it.h})<br>content lines...</div>\`;
    outer.appendChild(inner);
    container.appendChild(outer);
    // height reported will be from the measured inner
    results.push({idx, start:y, allocated: it.h + GAP, actualContent: it.h});
    y += it.h + GAP;
  });
  container.style.height = y + 'px';
  window.__DIAG = { results, total: y };
</script>
</body></html>`;

const browser = await chromium.launch({headless: true});
const page = await browser.newPage();
await page.setContent(html, {waitUntil:'load'});
await page.waitForTimeout(300);

const diag = await page.evaluate(() => window.__DIAG);

const computed = await page.evaluate(() => {
  const scroll = document.getElementById('scroll');
  const items = Array.from(document.querySelectorAll('#virt > div'));
  return items.map((el, i) => {
    const r = el.getBoundingClientRect();
    const prev = i>0 ? items[i-1].getBoundingClientRect() : null;
    const gap = prev ? Math.round( (r.top - (prev.top + prev.height)) * 100 ) / 100 : 0;
    return {i, top: Math.round(r.top), h: Math.round(r.height), gap, text: el.textContent.slice(0,40)};
  });
});

const gaps = computed.map(c => c.gap).filter((_,i)=>i>0);
const stats = {
  min: Math.min(...gaps),
  max: Math.max(...gaps),
  avg: gaps.reduce((a,b)=>a+b,0)/gaps.length,
  varying: gaps.some(g => Math.abs(g - 4) > 1),
  overlaps: gaps.some(g => g < -1),
};

console.log('Computed gaps from browser layout:', computed);
console.log('Stats:', stats);

await writeFile(path.join(OUT, 'diag.json'), JSON.stringify({diag, computed, stats}, null, 2));
await page.screenshot({path: path.join(OUT, 'layout.png'), fullPage:true});

await browser.close();
console.log('Diagnosis written to', OUT);
if (stats.varying || stats.overlaps) {
  console.log('ISSUE DETECTED: gaps not consistent at 4px. See diag.json');
  process.exit(1);
} else {
  console.log('Layout looks consistent in sim.');
}
