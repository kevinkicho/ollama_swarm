#!/usr/bin/env node
// Two-step verifier: (1) package.json must declare a `greet` script,
// (2) src/main.js must exist AND import + call greet from greeter.js
// AND emit "hello, world!\n" when run.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

try {
  // (1) package.json must declare a `greet` script
  const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
  if (!pkg.scripts?.greet) {
    console.error("FAIL: package.json must declare a `greet` script.");
    process.exit(1);
  }

  // (2) src/main.js must exist
  const mainPath = join(here, "src", "main.js");
  if (!existsSync(mainPath)) {
    console.error("FAIL: src/main.js missing.");
    process.exit(1);
  }
  const mainSrc = readFileSync(mainPath, "utf8");
  if (!/from\s+["']\.\/greeter\.js["']/.test(mainSrc)) {
    console.error("FAIL: src/main.js must import from ./greeter.js.");
    process.exit(1);
  }
  if (!/greet\s*\(/.test(mainSrc)) {
    console.error("FAIL: src/main.js must call greet(...).");
    process.exit(1);
  }

  // (2b) running it must emit "hello, world!\n"
  const r = spawnSync(process.execPath, [mainPath], { cwd: here });
  const out = r.stdout?.toString() ?? "";
  if (!out.includes("hello, world!")) {
    console.error(`FAIL: running src/main.js should print "hello, world!", got: ${JSON.stringify(out)}`);
    process.exit(1);
  }

  console.log("PASS: multistep-add-script");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
