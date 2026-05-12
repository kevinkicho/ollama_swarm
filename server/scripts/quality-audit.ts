#!/usr/bin/env node
// Testing & Quality Analysis — coverage, test quality, code health
// Usage: npx tsx server/scripts/quality-audit.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const srcDir = path.join(root, "server", "src");
const webDir = path.join(root, "web", "src");

// ── Helpers ──

function walkFiles(dir: string, pattern?: RegExp): string[] {
  const out: string[] = [];
  const s = statSync(dir, { throwIfNoEntry: false });
  if (!s || !s.isDirectory()) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const f = path.join(dir, entry);
    if (statSync(f).isDirectory()) {
      out.push(...walkFiles(f, pattern));
    } else if (!pattern || pattern.test(entry)) {
      out.push(f);
    }
  }
  return out;
}

function fileLines(f: string): number {
  return readFileSync(f, "utf8").split("\n").length;
}

function countPatterns(f: string, pattern: RegExp): number {
  return (readFileSync(f, "utf8").match(pattern) || []).length;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. TEST COVERAGE — File-level analysis
// ═══════════════════════════════════════════════════════════════════════════

console.log("=".repeat(62));
console.log("TESTING & QUALITY ANALYSIS — ollama_swarm");
console.log("=".repeat(62));

const allTsFiles = walkFiles(srcDir, /\.ts$/);
const testFiles = allTsFiles.filter((f) => f.endsWith(".test.ts"));
const sourceFiles = allTsFiles.filter((f) => !f.endsWith(".test.ts"));

// Group by directory
const dirs = new Map<string, { src: number; test: number; testLoc: number; srcLoc: number }>();
for (const f of sourceFiles) {
  const dir = path.dirname(path.relative(srcDir, f)) || "(root)";
  if (!dirs.has(dir)) dirs.set(dir, { src: 0, test: 0, testLoc: 0, srcLoc: 0 });
  dirs.get(dir)!.src++;
  dirs.get(dir)!.srcLoc += fileLines(f);
}
for (const f of testFiles) {
  const dir = path.dirname(path.relative(srcDir, f)) || "(root)";
  if (!dirs.has(dir)) dirs.set(dir, { src: 0, test: 0, testLoc: 0, srcLoc: 0 });
  dirs.get(dir)!.test++;
  dirs.get(dir)!.testLoc += fileLines(f);
}

console.log("\n── Coverage by directory ──");
console.log("Directory                          | Src | Tests | Src LOC | Test LOC | Ratio");
console.log("-".repeat(85));

let totalSrc = 0, totalTest = 0, totalSrcLoc = 0, totalTestLoc = 0;
for (const [dir, counts] of [...dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const ratio = counts.srcLoc > 0 ? (counts.testLoc / counts.srcLoc).toFixed(1) : "—";
  const label = dir.padEnd(33);
  console.log(
    `${label} | ${String(counts.src).padStart(3)} | ${String(counts.test).padStart(5)} | ${String(counts.srcLoc).padStart(7)} | ${String(counts.testLoc).padStart(8)} | ${ratio}x`,
  );
  totalSrc += counts.src;
  totalTest += counts.test;
  totalSrcLoc += counts.srcLoc;
  totalTestLoc += counts.testLoc;
}

const overallRatio = (totalTestLoc / totalSrcLoc).toFixed(1);
console.log("-".repeat(85));
console.log(
  `${"TOTAL".padEnd(33)} | ${String(totalSrc).padStart(3)} | ${String(totalTest).padStart(5)} | ${String(totalSrcLoc).padStart(7)} | ${String(totalTestLoc).padStart(8)} | ${overallRatio}x`,
);

// ═══════════════════════════════════════════════════════════════════════════
// 2. TEST QUALITY — Assertion density
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Test quality metrics ──");

let totalAssertions = 0;
let totalIts = 0;
let totalDescribes = 0;

const assertionDensity = new Map<string, { asserts: number; its: number; loc: number }>();

for (const f of testFiles) {
  const asserts = countPatterns(f, /\bassert\.\w+\(/g);
  const its = countPatterns(f, /\bit\(/g);
  const describes = countPatterns(f, /\bdescribe\(/g);
  const loc = fileLines(f);

  totalAssertions += asserts;
  totalIts += its;
  totalDescribes += describes;

  const name = path.relative(srcDir, f);
  assertionDensity.set(name, { asserts, its, loc });
}

console.log(`  Total test cases (it):    ${totalIts}`);
console.log(`  Total assertions:         ${totalAssertions}`);
console.log(`  Assertions per test case: ${(totalAssertions / totalIts).toFixed(1)}`);
console.log(`  Test files:               ${testFiles.length}`);
console.log(`  Describe blocks:          ${totalDescribes}`);

// Show files with highest/lowest assertion density
const sorted = [...assertionDensity.entries()]
  .filter(([, v]) => v.its > 0)
  .sort(([, a], [, b]) => (b.asserts / b.its) - (a.asserts / a.its));

console.log("\n  Highest assertion density:");
for (const [name, v] of sorted.slice(0, 5)) {
  console.log(`    ${(v.asserts / v.its).toFixed(1)}/it  ${name}`);
}

console.log("\n  Lowest assertion density (warning: < 2 asserts/it):");
const lowDensity = sorted.filter(([, v]) => v.asserts / v.its < 2);
for (const [name, v] of lowDensity.slice(0, 5)) {
  console.log(`    ${(v.asserts / v.its).toFixed(1)}/it  ${name}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. UNTESTED SOURCE FILES — Gap analysis
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Untested source files ──");

const testedDirs = new Set<string>();
for (const f of testFiles) {
  const dir = path.dirname(f);
  testedDirs.add(dir);
}

const untested = sourceFiles.filter((f) => {
  const base = path.basename(f, ".ts");
  const dir = path.dirname(f);
  const testPath = path.join(dir, `${base}.test.ts`);
  return !testFiles.includes(testPath);
});

// Only show significant untested files (> 50 LOC, non-export/template)
const significantUntested = untested
  .filter((f) => {
    const loc = fileLines(f);
    const name = path.basename(f);
    return loc > 50 && !name.startsWith("index") && !name.includes(".d.ts");
  })
  .slice(0, 15);

console.log(`  Untested source files: ${untested.length}`);
if (significantUntested.length > 0) {
  console.log("  Significant untested files (>50 LOC):");
  for (const f of significantUntested) {
    const loc = fileLines(f);
    console.log(`    ${String(loc).padStart(4)} LOC  ${path.relative(srcDir, f)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. CODE COMPLEXITY — Per-function line counts
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Largest files (complexity proxy) ──");

const allFilesByLoc = sourceFiles
  .map((f) => ({ name: path.relative(srcDir, f), loc: fileLines(f) }))
  .sort((a, b) => b.loc - a.loc)
  .slice(0, 10);

for (const f of allFilesByLoc) {
  console.log(`  ${String(f.loc).padStart(4)} LOC  ${f.name}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. DUPLICATION — Generic type usage and copy-paste detection
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Duplication risk ──");

// Check for identical long blocks (> 3 lines) across runner files
const runnerFiles = walkFiles(path.join(srcDir, "swarm"), /Runner\.ts$/);
const runnerBodies = runnerFiles.map((f) => {
  const content = readFileSync(f, "utf8");
  // Extract all 5+ line blocks
  const lines = content.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length - 4; i++) {
    blocks.push(lines.slice(i, i + 5).join("\n"));
  }
  return { file: path.basename(f), blocks };
});

// Find blocks that appear in 3+ files
const blockCounts = new Map<string, number>();
for (const { blocks } of runnerBodies) {
  const seen = new Set<string>();
  for (const b of blocks) {
    const key = b.slice(0, 60);
    if (!seen.has(key)) { seen.add(key); blockCounts.set(key, (blockCounts.get(key) ?? 0) + 1); }
  }
}

const dups = [...blockCounts.entries()].filter(([, c]) => c >= 4).sort(([, a], [, b]) => b - a);
console.log(`  Blocks appearing in 4+ runner files (likely duplication): ${dups.length}`);
if (dups.length > 0) {
  console.log("  Top duplicated blocks:");
  for (const [block, count] of dups.slice(0, 3)) {
    console.log(`    ${count}x  ${block.slice(0, 60)}...`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. TEST TYPE BREAKDOWN
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Test type breakdown ──");

const unitTests = testFiles.filter((f) => {
  const content = readFileSync(f, "utf8");
  return !content.includes("spawn") && !content.includes("fetch(") && !content.includes("WebSocket");
}).length;

const integrationTests = testFiles.length - unitTests;

console.log(`  Unit tests:          ${unitTests} files`);
console.log(`  Integration tests:   ${integrationTests} files (use spawn, fetch, or WebSocket)`);
console.log(`  E2E tests:           0 (no Playwright/selenium)`);

// ── Overall score ──
console.log("\n── OVERALL QUALITY SCORE ──");

const metrics = {
  "Test ratio (test LOC / src LOC)": Number(overallRatio),
  "Assertions per test case": Number((totalAssertions / totalIts).toFixed(1)),
  "Untested files (>50 LOC)": significantUntested.length,
  "Max file size (LOC)": allFilesByLoc[0]?.loc ?? 0,
  "Duplication risk (blocks in 4+ files)": dups.length,
  "E2E test coverage": 0,
};

let score = 0;
const details: string[] = [];

if (Number(overallRatio) >= 0.5) { score += 25; details.push("✓ Excellent test ratio (>0.5x)"); }
else if (Number(overallRatio) >= 0.2) { score += 15; details.push("◐ Good test ratio (>0.2x)"); }
else { score += 5; details.push("✗ Low test ratio"); }

if (totalAssertions / totalIts >= 3) { score += 20; details.push("✓ High assertion density (>3/it)"); }
else if (totalAssertions / totalIts >= 1.5) { score += 10; details.push("◐ Adequate assertion density (>1.5/it)"); }
else { score += 5; details.push("✗ Low assertion density"); }

if (significantUntested.length <= 5) { score += 20; details.push("✓ Few untested large files"); }
else if (significantUntested.length <= 15) { score += 10; details.push("◐ Moderate untested files"); }
else { score += 5; details.push("✗ Many untested large files"); }

if (allFilesByLoc[0]?.loc <= 1200) { score += 20; details.push("✓ All files < 1200 LOC"); }
else { score += 10; details.push("◐ Some large files"); }

if (dups.length <= 3) { score += 15; details.push("✓ Low duplication"); }
else { score += 5; details.push("✗ Moderate duplication"); }

console.log(`  Score: ${score}/100`);
for (const d of details) console.log(`    ${d}`);
