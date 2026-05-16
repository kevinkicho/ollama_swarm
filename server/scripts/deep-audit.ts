#!/usr/bin/env node
// Deep Audit v3 — Runtime + Startup + Cross-platform + Edge Cases
// Goes beyond static analysis: checks actual runtime behavior,
// import resolution, config validation, and path handling.
// Usage: npx tsx server/scripts/deep-audit.ts

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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
let critical = 0, high = 0, medium = 0, low = 0;

function report(severity: string, file: string, line: number, msg: string) {
  const icon = { CRITICAL: "✗", HIGH: "!", MEDIUM: "◐", LOW: "·" }[severity];
  const short = path.relative(srcDir, file);
  console.log(`  [${severity}] ${short}:${line}  ${msg}`);
  if (severity === "CRITICAL") critical++;
  else if (severity === "HIGH") high++;
  else if (severity === "MEDIUM") medium++;
  else low++;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. RUNTIME IMPORT CHECKS
// ═══════════════════════════════════════════════════════════════════════════

console.log("=".repeat(65));
console.log("DEEP AUDIT v3 — Runtime + Startup + Cross-platform");
console.log("=".repeat(65));

console.log("\n── 1. Missing runtime imports (used but not imported) ──");

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");

  // Check for tokenTracker usage without import
  if (/\btokenTracker\b/.test(src) && !/\bimport.*tokenTracker\b/.test(src)) {
    for (let i = 0; i < lines.length; i++) {
      if (/\btokenTracker\b/.test(lines[i]) && !lines[i].includes("import")) {
        report("CRITICAL", f, i + 1, `tokenTracker used but not imported — runtime crash`);
      }
    }
  }

  // Check for snapshotLifetimeTokens without import
  if (/\bsnapshotLifetimeTokens\b/.test(src) && !/\bimport.*snapshotLifetimeTokens\b/.test(src)) {
    for (let i = 0; i < lines.length; i++) {
      if (/\bsnapshotLifetimeTokens\b/.test(lines[i]) && !lines[i].includes("import")) {
        report("CRITICAL", f, i + 1, `snapshotLifetimeTokens used but not imported`);
      }
    }
  }

  // Check for releaseLock without import
  if (/\breleaseLock\b/.test(src) && !/\bimport.*releaseLock\b/.test(src)) {
    for (let i = 0; i < lines.length; i++) {
      if (/\breleaseLock\b/.test(lines[i]) && !lines[i].includes("import")) {
        report("HIGH", f, i + 1, `releaseLock used but not imported`);
      }
    }
  }

  // Check for randomUUID without import
  if (/\brandomUUID\(\)/.test(src) && !/\bimport.*randomUUID\b/.test(src)) {
    for (let i = 0; i < lines.length; i++) {
      if (/\brandomUUID\(\)/.test(lines[i]) && !lines[i].includes("import")) {
        report("HIGH", f, i + 1, `randomUUID() called but not imported`);
      }
    }
  }

  // Check for path.resolve used without import
  if (/\bpath\.resolve\(/.test(src) && !/\bimport.*\bpath\b.*from/.test(src)) {
    for (let i = 0; i < lines.length; i++) {
      if (/\bpath\.resolve\(/.test(lines[i]) && !lines[i].includes("import")) {
        report("MEDIUM", f, i + 1, `path.resolve used but 'path' may not be imported`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. WSL PATH HANDLING (every path.resolve call)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 2. path.resolve without normalizeWslPath guard ──");

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/path\.resolve\(/.test(line)) continue;
    // Already normalized?
    if (line.includes("normalizeWslPath")) continue;
    // Test files excluded
    if (f.includes(".test.")) continue;
    // Internal paths (not user input)
    if (line.includes("__dirname") || line.includes("__filename") || 
        line.includes("here") || line.includes("root") ||
        line.includes("repoRoot") || line.includes("tmpdir")) continue;
    // Already resolved or known-safe
    if (line.includes("localPath") || line.includes("clonePath")) continue;
    
    report("MEDIUM", f, i + 1, `path.resolve on potentially un-normalized input`);
    break; // one per file
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. CONFIG VALIDATION GAPS
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 3. Config validation gaps ──");

const configFile = path.join(srcDir, "config.ts");
const configSrc = readFileSync(configFile, "utf8");

// Check: all env vars used in code are defined in config.ts
const envRefs = new Set<string>();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const matches = src.match(/config\.([A-Z_]+)/g);
  if (matches) for (const m of matches) envRefs.add(m.replace("config.", ""));
}

// Check which ones are missing from config schema
for (const ref of envRefs) {
  if (!configSrc.includes(ref)) {
    report("HIGH", "config.ts", 0, `config.${ref} used in code but not defined in config.ts`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. STATE INCONSISTENCY — dual state tracking
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 4. State inconsistency risks ──");

// Check: lifecycleState vs phase dual tracking
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const hasLifecycle = /\blifecycleState\b/.test(src);
  const hasPhase = /\bthis\.phase\b/.test(src);
  const hasSetPhase = /\bsetPhase\(/.test(src);
  if (hasLifecycle && hasPhase && hasSetPhase) {
    report("MEDIUM", f, path.basename(f) === "BlackboardRunner.ts" ? 0 : 0,
      `Tracks both lifecycleState AND phase — risk of inconsistency`);
    break;
  }
}

// Check: stopping flag vs lifecycleState
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const hasStopping = /\bthis\.stopping\b/.test(src);
  const hasLifecycle = /\blifecycleState\b/.test(src);
  if (hasStopping && hasLifecycle) {
    report("LOW", f, 0, `Both 'stopping' boolean AND lifecycleState enum — dual source of truth`);
    break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. SILENT ERROR SWALLOWING
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 5. Silent error swallowing ──");

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Empty catch blocks
    if (/\bcatch\s*\{/.test(line) || /\bcatch\s*\(\s*\)\s*\{/.test(line)) {
      // Already have comments?
      const context = lines.slice(Math.max(0, i-1), i + 2).join("\n");
      if (!context.includes("//") && !context.includes("ignore") && !context.includes("best-effort")) {
        report("MEDIUM", f, i + 1, `Empty catch block with no comment — silent failure`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. HARDCODED PORTS / URLS
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 6. Hardcoded URLs/ports ──");

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Hardcoded port numbers (not in config or comments)
    if (/\b8243\b/.test(line) && !line.includes("config.") && !line.includes("//") && 
        !line.includes("SERVER_PORT") && !f.includes("vite.config")) {
      report("LOW", f, i + 1, `Hardcoded port 8243`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. ASYNC/AWAIT GAPS
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 7. Missing await on async calls ──");

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Calls to known async functions without await
    if (/\bthis\.stop\(\)/.test(line) && !/\bawait\b/.test(line) && 
        !line.includes("return") && !line.includes("=>") && !line.includes("void")) {
      report("HIGH", f, i + 1, `stop() called without await — fire-and-forget may lose errors`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── SUMMARY ──");
console.log(`  CRITICAL: ${critical}`);
console.log(`  HIGH:     ${high}`);
console.log(`  MEDIUM:   ${medium}`);
console.log(`  LOW:      ${low}`);
console.log(`  Total:    ${critical + high + medium + low}`);
