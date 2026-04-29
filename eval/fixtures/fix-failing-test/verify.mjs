#!/usr/bin/env node
// Just runs the project's tests via node --test. Exits 0 if all pass.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, ["--test", "src/sum.test.mjs"], {
  cwd: here,
  stdio: "inherit",
});
if (r.status === 0) {
  console.log("PASS: fix-failing-test");
  process.exit(0);
}
console.error("FAIL: src/sum.test.mjs still has a failing assertion");
process.exit(1);
