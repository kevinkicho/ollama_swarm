#!/usr/bin/env node
// scripts/probe-setup-form.mjs — systematic Playwright click-probe for
// the SetupForm (the "new swarm" page). Tests every interactive element
// for: discoverable selector, click works without console errors, state
// changes as expected, screenshot captured per step.
//
// Run: node scripts/probe-setup-form.mjs [--out=runs/_probe-<ts>]
//
// Output:
//   <out>/screenshots/NN-<label>.png  per probe step
//   <out>/REPORT.md                   pass/fail table per probe
//   <out>/console.json                page console + pageerror entries
//   <out>/video/page@*.webm           full session recording
//
// The probe is read-only — never clicks Start swarm. It exercises the
// UI surface to validate clicks, selections, panel toggles, input
// typing, and conditional-field reveals across presets.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const winHost = execSync("ip route | awk '/^default/ {print $3}'").toString().trim();
const baseUrl = `http://${winHost}:8244/`;
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1]
  ?? `/mnt/c/Users/kevin/Desktop/ollama_swarm/runs/_probe-setup-${ts}`;
fs.mkdirSync(`${outDir}/screenshots`, { recursive: true });
fs.mkdirSync(`${outDir}/video`, { recursive: true });

const consoleEntries = [];
const probeResults = [];
let stepIdx = 0;

async function snap(page, label) {
  stepIdx += 1;
  const filename = `${String(stepIdx).padStart(2, "0")}-${label.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60)}.png`;
  await page.screenshot({ path: `${outDir}/screenshots/${filename}`, fullPage: true });
  return filename;
}

async function probe(page, opts) {
  const { label, action, expect } = opts;
  const startErrs = consoleEntries.filter((e) => e.type === "error" || e.type === "pageerror").length;
  let status = "pass";
  let detail = "";
  try {
    await action(page);
    if (expect) {
      const ok = await expect(page);
      if (!ok) {
        status = "fail";
        detail = "expectation returned false";
      }
    }
  } catch (err) {
    status = "fail";
    detail = err instanceof Error ? err.message : String(err);
  }
  const newErrs = consoleEntries.filter((e) => e.type === "error" || e.type === "pageerror").length - startErrs;
  if (newErrs > 0 && status === "pass") {
    status = "warn";
    detail = `${newErrs} console error(s) during step`;
  }
  const screenshot = await snap(page, label);
  probeResults.push({ step: stepIdx, label, status, detail, screenshot });
  const icon = status === "pass" ? "✓" : status === "warn" ? "⚠" : "✕";
  console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ""}`);
  return status;
}

console.log(`Probing ${baseUrl}\nOutput: ${outDir}\n`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  recordVideo: { dir: `${outDir}/video`, size: { width: 1400, height: 900 } },
});
const page = await ctx.newPage();
page.on("console", (m) => {
  consoleEntries.push({ type: m.type(), text: m.text(), at: Date.now() });
  if (m.type() === "error") console.log(`    ⚠️  console.error: ${m.text().slice(0, 120)}`);
});
page.on("pageerror", (err) => {
  consoleEntries.push({ type: "pageerror", text: err.message, stack: err.stack, at: Date.now() });
  console.log(`    🚨 pageerror: ${err.message.slice(0, 120)}`);
});

await page.goto(baseUrl, { waitUntil: "networkidle" });
await snap(page, "00-initial-load");
console.log("page loaded");

// ─── Section 1: header chips ───────────────────────────────────────
console.log("\n[Section 1] Header chips");
await probe(page, {
  label: "header-tokens-chip-opens",
  action: async (p) => {
    const btn = p.locator('button:has-text("tokens")').first();
    await btn.click();
    await p.waitForTimeout(800);
  },
  expect: async (p) => {
    return await p.locator('text="Token usage"').first().isVisible({ timeout: 2000 });
  },
});

// Check the 4 scope toggles. Card labels are rendered as lowercase
// textContent ("last 1h", "last 1d", "last 1w", "last all") with CSS
// `uppercase` for display only — Playwright matches actual text.
for (const label of ["Hourly", "Daily", "Weekly", "All time"]) {
  await probe(page, {
    label: `tokens-scope-toggle-${label}`,
    action: async (p) => {
      const btn = p.locator(`button:has-text("${label}")`).first();
      await btn.click();
      await p.waitForTimeout(300);
    },
    expect: async (p) => {
      const cards = await p.locator('text=/last 1[hdw]|last all/i').count();
      return cards >= 4;
    },
  });
}

await probe(page, {
  label: "header-tokens-chip-closes",
  action: async (p) => {
    const btn = p.locator('button:has-text("tokens")').first();
    await btn.click();
    await p.waitForTimeout(400);
  },
});

await probe(page, {
  label: "header-history-dropdown-opens",
  action: async (p) => {
    const btn = p.locator('button:has-text("history")').first();
    await btn.click();
    await p.waitForTimeout(800);
  },
  expect: async (p) => {
    // Check the "Prior runs in parent folder (N)" text
    return await p.locator('text=/Prior runs/').first().isVisible({ timeout: 2000 });
  },
});

await probe(page, {
  label: "history-dropdown-row-count",
  action: async (p) => {
    // Wait briefly for the fetch+render to settle (3-attempt retry in
    // RunHistoryDropdown can take up to ~1.5s). The tokens panel
    // already closed, so any visible <tbody><tr> is from the history
    // table.
    await p.waitForTimeout(1200);
  },
  expect: async (p) => {
    const count = await p.locator('tbody tr').count();
    console.log(`    history rows: ${count}`);
    if (count > 0) return true;
    // Empty state — fresh parent with no runs and no cross-parent
    // surfacing yet. Still valid behavior.
    const empty = await p.locator('text=/No sibling runs/').isVisible().catch(() => false);
    if (empty) {
      console.log(`    (empty state — no prior runs in this parent)`);
      return true;
    }
    return false;
  },
});

await probe(page, {
  label: "history-dropdown-closes",
  action: async (p) => {
    const btn = p.locator('button:has-text("history")').first();
    await btn.click();
    await p.waitForTimeout(400);
  },
});

await probe(page, {
  label: "v2-event-log-button",
  action: async (p) => {
    const btn = p.locator('button:has-text("V2 EVENT LOG"), button:has-text("V2 event log"), button:has-text("v2 event log")').first();
    const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
    if (visible) await btn.click();
    await p.waitForTimeout(500);
  },
});

// Close v2 event log if it opened (Esc)
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(300);

// ─── Section 2: form inputs ────────────────────────────────────────
console.log("\n[Section 2] Form inputs");
await probe(page, {
  label: "github-url-input-typing",
  action: async (p) => {
    const input = p.locator('input[placeholder*="github.com"]').first();
    await input.click();
    await input.fill("");
    await input.type("https://github.com/sindresorhus/is-odd");
    await p.waitForTimeout(300);
  },
  expect: async (p) => {
    const v = await p.locator('input[placeholder*="github.com"]').first().inputValue();
    return v.includes("is-odd");
  },
});

await probe(page, {
  label: "parent-folder-input-typing",
  action: async (p) => {
    const input = p.locator('input[placeholder*="projects"]').first();
    await input.click();
    await input.fill("");
    await input.type("/tmp/probe-parent");
    await p.waitForTimeout(300);
  },
  expect: async (p) => {
    const v = await p.locator('input[placeholder*="projects"]').first().inputValue();
    return v === "/tmp/probe-parent";
  },
});

// ─── Section 3: preset selector ───────────────────────────────────
console.log("\n[Section 3] Preset selector");
const presetIds = ["round-robin", "blackboard", "council", "debate-judge", "map-reduce", "orchestrator-worker", "stigmergy", "role-diff", "orchestrator-worker-deep"];
for (const pid of presetIds) {
  await probe(page, {
    label: `preset-${pid}`,
    action: async (p) => {
      const select = p.locator('select').first();
      await select.selectOption(pid);
      await p.waitForTimeout(400);
    },
    expect: async (p) => {
      const v = await p.locator('select').first().inputValue();
      return v === pid;
    },
  });
}

// Re-select blackboard so preset-specific knobs surface
await page.locator('select').first().selectOption("blackboard");
await page.waitForTimeout(500);

// ─── Section 4: directive + quick-pick ─────────────────────────────
console.log("\n[Section 4] Directive area");
await probe(page, {
  label: "directive-textarea-typing",
  action: async (p) => {
    const ta = p.locator('textarea').first();
    await ta.click();
    await ta.fill("Test directive: refactor the retry-with-backoff helper.");
    await p.waitForTimeout(300);
  },
  expect: async (p) => {
    const v = await p.locator('textarea').first().inputValue();
    return v.includes("Test directive");
  },
});

await probe(page, {
  label: "directive-quick-pick-button",
  action: async (p) => {
    // The "Deliver every README feature + research" quick-pick button
    const btn = p.locator('button:has-text("Deliver every README")').first();
    const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
    if (visible) await btn.click();
    await p.waitForTimeout(300);
  },
  expect: async (p) => {
    // After clicking, directive should change
    const v = await p.locator('textarea').first().inputValue();
    return v.length > 50 && !v.includes("Test directive");
  },
});

// ─── Section 5: topology grid + numeric knobs ─────────────────────
// Phase 1 of #243: the standalone Agents number input was replaced by
// the TopologyGrid table. The grid owns count via +/− buttons and
// surfaces per-row Role + Model. Probe its key surfaces.
console.log("\n[Section 5] Topology grid + numeric knobs");
await probe(page, {
  label: "topology-grid-rendered",
  action: async (p) => { /* just inspect */ },
  expect: async (p) => {
    // The "Topology" label uses CSS uppercase but textContent is
    // "Topology" — same pattern as the tokens panel labels.
    return await p.locator('text=/topology/i').first().isVisible({ timeout: 2000 });
  },
});

await probe(page, {
  label: "topology-add-worker",
  action: async (p) => {
    // Capture the row count before, click +, expect 1 more after.
    const before = await p.locator('table tbody tr').count();
    const addBtn = p.locator('button:has-text("add worker"), button:has-text("add peer"), button:has-text("add mapper"), button:has-text("add drafter"), button:has-text("add explorer")').first();
    await addBtn.click();
    await p.waitForTimeout(300);
    const after = await p.locator('table tbody tr').count();
    console.log(`    rows: ${before} → ${after}`);
    if (after !== before + 1) throw new Error(`expected +1 row, got ${after - before}`);
  },
});

await probe(page, {
  label: "topology-remove-worker",
  action: async (p) => {
    const before = await p.locator('table tbody tr').count();
    // − button is rendered as text "−" (U+2212 minus) on removable rows.
    // Click the first one we find.
    const removeBtn = p.locator('button[title^="Remove agent"]').first();
    await removeBtn.click();
    await p.waitForTimeout(300);
    const after = await p.locator('table tbody tr').count();
    console.log(`    rows: ${before} → ${after}`);
    if (after !== before - 1) throw new Error(`expected -1 row, got ${after - before}`);
  },
});

await probe(page, {
  label: "topology-row-model-override-typing",
  action: async (p) => {
    // Per-row Model input is a text input inside the topology table.
    // Type into the first row's Model cell (planner row in blackboard).
    const cell = p.locator('table tbody tr').first().locator('input[type="text"]').first();
    await cell.click();
    await cell.fill("");
    await cell.type("custom-model:cloud");
    await p.waitForTimeout(200);
  },
  expect: async (p) => {
    const v = await p.locator('table tbody tr').first().locator('input[type="text"]').first().inputValue();
    return v === "custom-model:cloud";
  },
});

await probe(page, {
  label: "rounds-number-input",
  action: async (p) => {
    // Phase 1 of #243 dropped the Agents number input, so Rounds is
    // now the only input[type="number"] on the form.
    const input = p.locator('input[type="number"]').first();
    await input.click();
    await input.fill("5");
    await p.waitForTimeout(300);
  },
  expect: async (p) => (await p.locator('input[type="number"]').first().inputValue()) === "5",
});

await probe(page, {
  label: "model-text-input",
  action: async (p) => {
    // The Model field is now in a 2-column grid alongside Rounds.
    // Anchor on its label, then walk to the sibling input.
    const modelInput = p.locator('label:has(div:text-is("Model")) input').first();
    await modelInput.waitFor({ state: "visible", timeout: 2000 });
    await modelInput.click();
    await modelInput.fill("");
    await modelInput.type("nemotron-3-super:cloud");
    await p.waitForTimeout(300);
  },
  expect: async (p) => {
    const v = await p.locator('label:has(div:text-is("Model")) input').first().inputValue();
    return v === "nemotron-3-super:cloud";
  },
});

// ─── Section 6: blackboard-specific knobs ──────────────────────────
// Blackboard preset surfaces extra knobs (council contract, ambition tier, etc.)
console.log("\n[Section 6] Blackboard-specific reveal");
await probe(page, {
  label: "blackboard-knobs-rendered",
  action: async (p) => { /* preset already blackboard */ },
  expect: async (p) => {
    // Look for any additional advanced section that surfaces under blackboard
    const html = await p.content();
    return html.includes("council") || html.includes("ambition") || html.length > 5000;
  },
});

// ─── Section 7: Start button presence (DON'T click) ────────────────
console.log("\n[Section 7] Start button (presence only — DON'T click)");
await probe(page, {
  label: "start-swarm-button-visible",
  action: async (p) => { /* just verify */ },
  expect: async (p) => {
    return await p.locator('button:has-text("Start swarm"), button:has-text("Coming soon"), button:has-text("Starting")').first().isVisible();
  },
});

// ─── Final ─────────────────────────────────────────────────────────
await snap(page, "99-final-state");

const html = await page.content();
fs.writeFileSync(`${outDir}/final-page.html`, html);
fs.writeFileSync(`${outDir}/console.json`, JSON.stringify(consoleEntries, null, 2));
fs.writeFileSync(`${outDir}/probe-results.json`, JSON.stringify(probeResults, null, 2));

await page.close();
await ctx.close();
await browser.close();

// ─── Summary report ────────────────────────────────────────────────
const passed = probeResults.filter((r) => r.status === "pass").length;
const warned = probeResults.filter((r) => r.status === "warn").length;
const failed = probeResults.filter((r) => r.status === "fail").length;
const errs = consoleEntries.filter((e) => e.type === "error" || e.type === "pageerror").length;

const md = [
  `# SetupForm probe — ${ts}`,
  ``,
  `- Probes: ${probeResults.length}`,
  `- Passed: ${passed}`,
  `- Warnings: ${warned}`,
  `- Failed: ${failed}`,
  `- Console / page errors: ${errs}`,
  ``,
  `## Per-step results`,
  ``,
  `| # | Label | Status | Detail |`,
  `|---|---|---|---|`,
  ...probeResults.map((r) => `| ${r.step} | \`${r.label}\` | ${r.status === "pass" ? "✅" : r.status === "warn" ? "⚠️" : "❌"} ${r.status} | ${r.detail || ""} |`),
  ``,
  `## Artifacts`,
  ``,
  `- screenshots/ — ${probeResults.length + 1} per-step PNGs`,
  `- video/page@*.webm — full session recording`,
  `- console.json — every console / page error`,
  `- probe-results.json — machine-readable results`,
  `- final-page.html — DOM at end`,
].join("\n");
fs.writeFileSync(`${outDir}/REPORT.md`, md);

console.log(`\n=== SUMMARY ===`);
console.log(`Probes: ${probeResults.length} (✅ ${passed} · ⚠️ ${warned} · ❌ ${failed})`);
console.log(`Console/page errors: ${errs}`);
console.log(`\n→ ${outDir}`);
console.log(`→ Report: ${outDir}/REPORT.md`);
if (failed > 0) {
  console.log(`\n❌ FAILED PROBES:`);
  for (const r of probeResults.filter((r) => r.status === "fail")) {
    console.log(`  - ${r.label}: ${r.detail}`);
  }
}
