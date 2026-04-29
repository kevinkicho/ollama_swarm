#!/usr/bin/env node
// Analysis-style verifier. Swarm is asked to read package.json and
// produce categories.json with shape:
//   { runtime: string[], dev: string[], optional: string[] }
// Each list contains the dependency NAMES (not version strings).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = join(here, "categories.json");

const EXPECTED = {
  runtime: ["express", "zod"],
  dev: ["vitest", "@types/node"],
  optional: ["fsevents"],
};

function setEqual(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

try {
  if (!existsSync(reportPath)) {
    console.error("FAIL: categories.json missing.");
    process.exit(1);
  }
  const cat = JSON.parse(readFileSync(reportPath, "utf8"));
  for (const k of ["runtime", "dev", "optional"]) {
    if (!Array.isArray(cat[k])) {
      console.error(`FAIL: categories.${k} must be an array.`);
      process.exit(1);
    }
    if (!setEqual(cat[k], EXPECTED[k])) {
      console.error(`FAIL: categories.${k} mismatch — got ${JSON.stringify(cat[k])}, expected ${JSON.stringify(EXPECTED[k])}.`);
      process.exit(1);
    }
  }
  console.log("PASS: categorize-deps");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
