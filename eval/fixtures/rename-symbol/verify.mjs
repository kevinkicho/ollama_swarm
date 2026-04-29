#!/usr/bin/env node
// Verify command for the rename-symbol fixture. Two gates:
//   1. NO file under src/ references the old name `oldSum`.
//   2. The renamed module is callable and returns 3 (1 + 2).
// Exits 0 on both pass, 1 otherwise. Self-contained.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, "src");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const s = statSync(abs);
    if (s.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

try {
  const offenders = [];
  for (const file of walk(SRC_DIR)) {
    const text = readFileSync(file, "utf8");
    if (text.includes("oldSum")) offenders.push(file);
  }
  if (offenders.length > 0) {
    console.error("FAIL: `oldSum` still referenced in:", offenders.join(", "));
    process.exit(1);
  }
  // Behavior gate: import the renamed module and check the result.
  const main = await import("./src/main.js");
  if (typeof main.run !== "function") {
    console.error("FAIL: src/main.js no longer exports `run`.");
    process.exit(1);
  }
  if (main.run() !== 3) {
    console.error(`FAIL: run() returned ${main.run()}, expected 3.`);
    process.exit(1);
  }
  console.log("PASS: rename-symbol");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
