#!/usr/bin/env node
// Analysis-style verifier: the swarm is asked to produce a JSON report
// at `report.json` listing every console.log occurrence in src/. We
// assert the shape: { count: 5, calls: [{file, line}, ...] } with
// every entry pointing at src/main.js.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = join(here, "report.json");

try {
  if (!existsSync(reportPath)) {
    console.error("FAIL: report.json missing — swarm should have written it.");
    process.exit(1);
  }
  const raw = readFileSync(reportPath, "utf8");
  const report = JSON.parse(raw);
  if (typeof report.count !== "number") {
    console.error("FAIL: report.json missing numeric `count`.");
    process.exit(1);
  }
  if (!Array.isArray(report.calls)) {
    console.error("FAIL: report.json missing `calls` array.");
    process.exit(1);
  }
  if (report.count !== 5) {
    console.error(`FAIL: expected count=5, got ${report.count}.`);
    process.exit(1);
  }
  if (report.calls.length !== 5) {
    console.error(`FAIL: expected calls.length=5, got ${report.calls.length}.`);
    process.exit(1);
  }
  for (const c of report.calls) {
    if (typeof c.file !== "string" || typeof c.line !== "number") {
      console.error("FAIL: every call must have {file: string, line: number}.");
      process.exit(1);
    }
    if (!c.file.endsWith("main.js")) {
      console.error(`FAIL: every call should point at main.js; got ${c.file}.`);
      process.exit(1);
    }
  }
  console.log("PASS: audit-console-logs");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
