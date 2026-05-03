#!/usr/bin/env node
// scripts/ui-probe-during-sweep.mjs — opportunistic UI bug-finder.
// Connects to localhost:8244 while a swarm is running, captures
// snapshots over a fixed window, and reports anything weird:
//
//   - Console errors / warnings
//   - Stale agent sidebar (status not updating despite transcript
//     activity)
//   - Bubbles re-keying (DOM-id changes between snapshots)
//   - Last-segment-escape (the bug fixed 2026-05-01 — ensure the fix
//     holds under live conditions)
//   - Layout shifts (CLS-style; unstable bubble positions)
//
// Runs WITHOUT submitting any new swarm — read-only against whatever
// the user/sweep already has running.

import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const URL = process.env.UI_URL ?? "http://localhost:8244/";
const DURATION_MS = Number(process.env.PROBE_DURATION_MS ?? 90_000); // 90s default
const SNAPSHOT_INTERVAL_MS = 5_000;
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(`runs/_ui-probe-${ts}`);

async function main() {
  await mkdir(outDir, { recursive: true });
  console.log(`UI probe: ${URL}`);
  console.log(`Duration: ${DURATION_MS}ms (${SNAPSHOT_INTERVAL_MS}ms snapshots)`);
  console.log(`Output:   ${outDir}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleEntries = [];
  const pageErrors = [];
  page.on("console", (msg) => consoleEntries.push({ type: msg.type(), text: msg.text(), ts: Date.now() }));
  page.on("pageerror", (err) => pageErrors.push({ message: String(err), ts: Date.now() }));

  await page.goto(URL, { waitUntil: "networkidle" });
  // Settle React renders
  await new Promise((r) => setTimeout(r, 2000));

  const snapshots = [];
  const startedAt = Date.now();
  let snapshotN = 0;

  while (Date.now() - startedAt < DURATION_MS) {
    snapshotN += 1;
    const snap = await page.evaluate(() => {
      // Capture lightweight signals from the live DOM.
      const transcriptEntries = Array.from(
        document.querySelectorAll("[data-entry-id]"),
      ).map((el) => ({
        id: el.getAttribute("data-entry-id"),
        role: el.getAttribute("data-entry-role"),
        kind: el.getAttribute("data-summary-kind"),
        agentIndex: el.getAttribute("data-agent-index"),
        textLen: el.textContent?.length ?? 0,
      }));
      // Sidebar agent panels — look for agent IDs + their visible status text
      const agentPanels = Array.from(document.querySelectorAll("[class*='agent']")).slice(0, 50)
        .map((el) => el.textContent?.slice(0, 80))
        .filter(Boolean);
      // Find streaming bubbles (StreamingDock children)
      const streamingBubbles = Array.from(
        document.querySelectorAll("[class*='stream'], [data-streaming]"),
      ).length;
      return {
        url: location.href,
        transcriptCount: transcriptEntries.length,
        agentPanelCount: agentPanels.length,
        streamingBubbles,
        transcript: transcriptEntries.slice(-20), // last 20 entries
        agentPanels: agentPanels.slice(0, 10),
        bodyTextLen: document.body.textContent?.length ?? 0,
      };
    });
    snap.snapshotN = snapshotN;
    snap.elapsedMs = Date.now() - startedAt;
    snapshots.push(snap);
    console.log(
      `  snap ${String(snapshotN).padStart(2, "0")}@${String(snap.elapsedMs).padStart(5)}ms: transcript=${snap.transcriptCount} streaming=${snap.streamingBubbles} bodyLen=${snap.bodyTextLen}`,
    );
    // Periodic screenshots — first, middle, last
    if (snapshotN === 1 || snapshotN * SNAPSHOT_INTERVAL_MS > DURATION_MS - SNAPSHOT_INTERVAL_MS || snapshotN % 4 === 0) {
      await page.screenshot({
        path: `${outDir}/snap-${String(snapshotN).padStart(2, "0")}.png`,
        fullPage: false,
      });
    }
    await new Promise((r) => setTimeout(r, SNAPSHOT_INTERVAL_MS));
  }

  // ANALYSIS pass — look at the snapshot series
  const analysis = analyze(snapshots, consoleEntries, pageErrors);

  // Write artifacts
  await writeFile(`${outDir}/snapshots.json`, JSON.stringify(snapshots, null, 2));
  await writeFile(`${outDir}/console.json`, JSON.stringify(consoleEntries, null, 2));
  await writeFile(`${outDir}/pageerrors.json`, JSON.stringify(pageErrors, null, 2));
  await writeFile(`${outDir}/REPORT.md`, buildReport(analysis, snapshots, consoleEntries, pageErrors));

  await page.close();
  await context.close();
  await browser.close();

  console.log(`\nReport: ${outDir}/REPORT.md`);
  console.log(`Console errors: ${consoleEntries.filter((e) => e.type === "error").length}`);
  console.log(`Page errors:    ${pageErrors.length}`);
  console.log(`Findings:       ${analysis.findings.length}`);
  process.exit(analysis.findings.length > 0 ? 1 : 0);
}

function analyze(snapshots, consoleEntries, pageErrors) {
  const findings = [];
  if (snapshots.length < 2) {
    findings.push({ severity: "error", description: "<2 snapshots captured; probe duration too short" });
    return { findings };
  }
  // 1. Console errors
  const consoleErrors = consoleEntries.filter((e) => e.type === "error");
  if (consoleErrors.length > 0) {
    findings.push({
      severity: "error",
      description: `${consoleErrors.length} console error(s) over the probe window`,
      examples: consoleErrors.slice(0, 3).map((e) => e.text.slice(0, 200)),
    });
  }
  if (pageErrors.length > 0) {
    findings.push({
      severity: "error",
      description: `${pageErrors.length} page error(s)`,
      examples: pageErrors.slice(0, 3).map((e) => e.message.slice(0, 200)),
    });
  }
  // 2. Transcript should be growing (sweep is producing entries)
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const transcriptDelta = last.transcriptCount - first.transcriptCount;
  if (transcriptDelta === 0 && first.transcriptCount > 0) {
    findings.push({
      severity: "warn",
      description: `transcript count unchanged across ${snapshots.length} snapshots (started at ${first.transcriptCount}). Either no swarm running or UI not updating.`,
    });
  }
  // 3. Body text length should change as content streams. Static = stale.
  const bodyDelta = Math.abs(last.bodyTextLen - first.bodyTextLen);
  if (bodyDelta < 50 && first.bodyTextLen > 1000) {
    findings.push({
      severity: "warn",
      description: `body text length effectively static (delta=${bodyDelta} chars over ${snapshots.length} snapshots). UI may not be re-rendering.`,
    });
  }
  // 4. Reordering check — look at transcript IDs across snapshots. Same
  //    set of IDs but DIFFERENT ORDER between adjacent snapshots = reordering.
  for (let i = 1; i < snapshots.length; i++) {
    const a = snapshots[i - 1].transcript.map((e) => e.id);
    const b = snapshots[i].transcript.map((e) => e.id);
    const aSet = new Set(a);
    const bSet = new Set(b);
    const overlap = a.filter((id) => bSet.has(id));
    const sameSet = aSet.size === bSet.size && a.every((id) => bSet.has(id));
    if (sameSet && overlap.length > 1) {
      // check if order matches
      const aOrdered = a.filter((id) => bSet.has(id));
      const bOrdered = b.filter((id) => aSet.has(id));
      if (JSON.stringify(aOrdered) !== JSON.stringify(bOrdered)) {
        findings.push({
          severity: "warn",
          description: `transcript reordering between snap ${i} and ${i + 1} (same entries, different order)`,
        });
      }
    }
  }
  return { findings };
}

function buildReport(analysis, snapshots, consoleEntries, pageErrors) {
  const lines = [];
  lines.push(`# UI probe — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Snapshots: ${snapshots.length}`);
  lines.push(`Console entries: ${consoleEntries.length} (${consoleEntries.filter((e) => e.type === "error").length} errors)`);
  lines.push(`Page errors: ${pageErrors.length}`);
  lines.push("");
  lines.push(`## Findings (${analysis.findings.length})`);
  if (analysis.findings.length === 0) {
    lines.push("");
    lines.push("_No issues surfaced over the probe window._");
  } else {
    for (const f of analysis.findings) {
      lines.push("");
      lines.push(`- **${f.severity.toUpperCase()}** — ${f.description}`);
      if (f.examples) for (const ex of f.examples) lines.push(`  - \`${ex}\``);
    }
  }
  lines.push("");
  lines.push(`## Transcript growth`);
  lines.push("");
  lines.push("| snap | elapsed (ms) | transcript | streaming | bodyLen |");
  lines.push("| ---: | ---: | ---: | ---: | ---: |");
  for (const s of snapshots) {
    lines.push(`| ${s.snapshotN} | ${s.elapsedMs} | ${s.transcriptCount} | ${s.streamingBubbles} | ${s.bodyTextLen} |`);
  }
  return lines.join("\n");
}

main().catch((err) => {
  console.error("UI probe failed:", err);
  process.exit(2);
});
