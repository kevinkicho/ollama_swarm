#!/usr/bin/env node
// Autoresearch — scans the codebase for patterns, anti-patterns,
// inconsistencies, and optimization opportunities.
// Usage: npx tsx server/scripts/autoresearch.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const srcDir = path.join(root, "server", "src");

function walk(dir: string, ext = ".ts"): string[] {
  const out: string[] = [];
  const s = statSync(dir, { throwIfNoEntry: false });
  if (!s?.isDirectory()) return out;
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".") || e === "node_modules") continue;
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) out.push(...walk(f, ext));
    else if (e.endsWith(ext) && !e.includes(".test.")) out.push(f);
  }
  return out;
}

const files = walk(srcDir);
const totalFiles = files.length;

// ═══════════════════════════════════════════════════════════════════════════
// 1. TODO / FIXME / HACK comments
// ═══════════════════════════════════════════════════════════════════════════

console.log("=".repeat(62));
console.log("AUTORESEARCH — ollama_swarm");
console.log("=".repeat(62));

console.log("\n── 1. TODO / FIXME / HACK ──");
let todoCount = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\/\/.*(TODO|FIXME|HACK|XXX)\b/i.test(line) && !line.includes("this file")) {
      if (todoCount < 15) {
        const short = path.relative(srcDir, f);
        console.log(`  ${short}:${i + 1}  ${line.trim().slice(0, 78)}`);
      }
      todoCount++;
    }
  }
}
console.log(`  Total: ${todoCount} TODO/FIXME/HACK comments`);

// ═══════════════════════════════════════════════════════════════════════════
// 2. Console.log in production paths (not tests)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 2. console.log/warn/error in source ──");
let consoleCount = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bconsole\.(log|warn|error)\(/.test(line) && !line.includes("//")) {
      // Skip intentional ones: startup messages, error handlers, broadcast
      if (line.includes("ollama_swarm server listening") ||
          line.includes("SHUTTING_DOWN") ||
          line.includes("[ws]") ||
          line.includes("[proxy]") ||
          line.includes("[drift-guard]") ||
          line.includes("Orchestrator]") ||
          line.includes("orphan") ||
          line.includes("auto-resume") ||
          line.includes("cleanup")) continue;
      consoleCount++;
      if (consoleCount <= 10) {
        console.log(`  ${path.relative(srcDir, f)}:${i + 1}`);
      }
    }
  }
}
console.log(`  Unannotated console statements: ${consoleCount}`);

// ═══════════════════════════════════════════════════════════════════════════
// 3. Large functions (>100 lines)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 3. Functions > 80 lines ──");
const largeFns: Array<{ file: string; fn: string; loc: number }> = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  let inFn = false;
  let fnName = "";
  let fnStart = 0;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fnMatch = line.match(/(?:async\s+)?(?:function\s+)?(\w+)\s*\([^)]*\)\s*\{/);
    if (fnMatch && !line.includes("=>") && !line.includes("if (") && !line.includes("for (") && !line.includes("while (")) {
      if (!inFn) {
        inFn = true;
        fnName = fnMatch[1];
        fnStart = i;
        depth = 1;
        // The opening brace is on this line
      } else {
        depth++;
      }
    } else if (inFn) {
      for (const ch of line) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      if (depth === 0) {
        const length = i - fnStart + 1;
        if (length > 80) {
          largeFns.push({
            file: path.relative(srcDir, f),
            fn: fnName,
            loc: length,
          });
        }
        inFn = false;
      }
    }
  }
}

largeFns.sort((a, b) => b.loc - a.loc);
for (const fn of largeFns.slice(0, 10)) {
  console.log(`  ${String(fn.loc).padStart(4)} LOC  ${fn.fn.padEnd(25)}  ${fn.file}`);
}
console.log(`  Total functions > 80 LOC: ${largeFns.length}`);

// ═══════════════════════════════════════════════════════════════════════════
// 4. Copy-pasted blocks (>5 identical consecutive lines)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 4. Identical code blocks across files ──");
const blockMap = new Map<string, string[]>();
for (const f of files.filter((f) => path.basename(f).includes("Runner"))) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length - 4; i++) {
    const block = lines.slice(i, i + 5).join("\n");
    const key = block.slice(0, 80);
    if (!blockMap.has(key)) blockMap.set(key, []);
    blockMap.get(key)!.push(path.basename(f));
  }
}

const dupBlocks = [...blockMap.entries()]
  .filter(([, files]) => [...new Set(files)].length >= 3)
  .sort(([, a], [, b]) => b.length - a.length);

console.log(`  Blocks appearing in 3+ runner files: ${dupBlocks.length}`);
for (const [block, filenames] of dupBlocks.slice(0, 5)) {
  const unique = [...new Set(filenames)];
  console.log(`    ${unique.length}x  ${unique.join(", ")}`);
  console.log(`    ${block.slice(0, 60)}...`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Inconsistent naming patterns
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 5. Inconsistent naming ──");
const namingIssues: string[] = [];

// Check: emitOutcome vs emit vs opts.emit pattern consistency
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const emitCalls = (src.match(/emit\(/g) || []).length;
  const optsEmitCalls = (src.match(/opts\.emit\(/g) || []).length;
  const emit = (src.match(/this\.opts\.emit\(/g) || []).length;
  if (emitCalls > 0 && optsEmitCalls > 0) {
    namingIssues.push(`${path.basename(f)}: uses both emit() and opts.emit() in same file`);
  }
}

for (const issue of namingIssues.slice(0, 5)) {
  console.log(`  ${issue}`);
}

// Check: string literals used as types vs enums
const stringTypeIssues = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  // Find string literals that look like state names used without the enum
  const bareStrings = src.match(/["'](?:idle|running|stopping|stopped|draining|paused|completed|failed)["']/g);
  const enumUsage = (src.match(/SwarmPhase\./g) || []).length;
  if (bareStrings && bareStrings.length > 3 && enumUsage === 0) {
    stringTypeIssues.push(`${path.basename(f)}: ${bareStrings.length} bare state strings, 0 SwarmPhase enum refs`);
  }
}

for (const issue of stringTypeIssues.slice(0, 5)) {
  console.log(`  ${issue}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Dead code (unused exports, unreachable paths)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 6. Potentially dead code ──");

// Check for functions that are only called in test files
const defMap = new Map<string, string[]>(); // function name → files that call it
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const exported = [...src.matchAll(/export (?:async )?function (\w+)/g)];
  for (const [, name] of exported) {
    // Search ALL files for calls to this function
    for (const of of files) {
      if (of === f) continue;
      const otherSrc = readFileSync(of, "utf8");
      if (otherSrc.includes(`${name}(`) || otherSrc.includes(`${name} (`)) {
        if (!defMap.has(name)) defMap.set(name, []);
        defMap.get(name)!.push(path.relative(srcDir, of));
      }
    }
  }
}

const unused = [...defMap.entries()].filter(([, callers]) => callers.length === 0);
if (unused.length > 0) {
  console.log(`  Potentially unused exports (no non-test callers found):`);
  for (const [name] of unused.slice(0, 8)) {
    console.log(`    ${name}()`);
  }
} else {
  console.log("  All exports have at least one caller.");
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Error handling gaps
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 7. Error handling gaps ──");

let unguardedCalls = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  // Calls that should probably be in try/catch but aren't
  const riskyPatterns = [
    { pattern: /JSON\.parse\((?!.*try)/g, label: "JSON.parse outside try" },
    { pattern: /fs\.readFileSync(?!.*try)/g, label: "readFileSync outside try" },
  ];
  for (const { pattern, label } of riskyPatterns) {
    const matches = src.match(pattern);
    if (matches && matches.length > 0) {
      unguardedCalls++;
      break;
    }
  }
}
console.log(`  Files with potentially unguarded risky calls: ${unguardedCalls}`);

// ═══════════════════════════════════════════════════════════════════════════
// 8. Complexity hotspots
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 8. Complexity hotspots ──");

// Files with high cyclomatic complexity indicators
const complexity = files.map((f) => {
  const src = readFileSync(f, "utf8");
  const ifs = (src.match(/\bif\s*\(/g) || []).length;
  const switches = (src.match(/\bswitch\s*\(/g) || []).length;
  const loops = (src.match(/\bfor\s*\(/g) || []).length + (src.match(/\bwhile\s*\(/g) || []).length;
  const tries = (src.match(/\btry\s*\{/g) || []).length;
  const lines = src.split("\n").length;
  const score = ifs + switches * 2 + loops * 2 + tries;
  return { file: path.relative(srcDir, f), lines, score, density: (score / lines).toFixed(2) };
});

complexity.sort((a, b) => b.score - a.score);
console.log("  File                                         | Lines | Score | Density");
console.log("  " + "-".repeat(60));
for (const c of complexity.slice(0, 10)) {
  console.log(`  ${c.file.padEnd(45)} | ${String(c.lines).padStart(5)} | ${String(c.score).padStart(5)} | ${c.density}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Dependency graph: files with no tests
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 9. Untested source files (>100 LOC) ──");
const untested = files.filter((f) => {
  const base = path.basename(f, ".ts");
  const dir = path.dirname(f);
  const testPath = path.join(dir, `${base}.test.ts`);
  try { statSync(testPath); return false; } catch { return true; }
}).filter((f) => {
  const lines = readFileSync(f, "utf8").split("\n").length;
  return lines > 100;
}).slice(0, 10);

for (const f of untested) {
  const lines = readFileSync(f, "utf8").split("\n").length;
  console.log(`  ${String(lines).padStart(4)} LOC  ${path.relative(srcDir, f)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── RESEARCH SUMMARY ──");
console.log(`  Files analyzed:     ${totalFiles}`);
console.log(`  TODO/FIXME/HACK:    ${todoCount}`);
console.log(`  Large functions:    ${largeFns.length}`);
console.log(`  Duplicate blocks:   ${dupBlocks.length} (3+ runners)`);
console.log(`  Complexity > avg:   ${complexity.filter(c => Number(c.density) > 0.05).length} files`);
console.log(`  Untested >100 LOC:  ${untested.length}`);
console.log("");

// Top 3 actionable findings
console.log("  Top 3 findings:");
console.log(`  1. ${todoCount} TODO/FIXME/HACK comments — oldest technical debt`);
console.log(`  2. ${largeFns.length} functions > 80 LOC — extraction candidates`);
console.log(`  3. ${dupBlocks.length} duplicate blocks across runners — further consolidation possible`);
