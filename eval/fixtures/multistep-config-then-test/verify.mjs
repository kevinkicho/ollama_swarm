#!/usr/bin/env node
// Two-step verifier:
//   (1) src/log.js must support opts.verbose === true such that the
//       output contains "[v]" after the level marker.
//   (2) A test file must exist at src/log.test.mjs that exercises BOTH
//       verbose-true and verbose-false (default) paths AND passes when
//       run via node --test.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { formatLog } from "./src/log.js";

const here = dirname(fileURLToPath(import.meta.url));

try {
  // (1a) verbose=true must include [v]
  const verboseOut = formatLog("info", "hello", { verbose: true });
  if (!verboseOut.includes("[v]")) {
    console.error(`FAIL: formatLog with verbose=true must include "[v]"; got: ${JSON.stringify(verboseOut)}`);
    process.exit(1);
  }
  // (1b) default / verbose=false must NOT include [v]
  const quietOut = formatLog("info", "hello");
  if (quietOut.includes("[v]")) {
    console.error(`FAIL: formatLog without verbose must NOT include "[v]"; got: ${JSON.stringify(quietOut)}`);
    process.exit(1);
  }

  // (2) test file must exist + reference verbose
  const testPath = join(here, "src", "log.test.mjs");
  if (!existsSync(testPath)) {
    console.error("FAIL: src/log.test.mjs missing.");
    process.exit(1);
  }
  const testSrc = readFileSync(testPath, "utf8");
  if (!/verbose/i.test(testSrc)) {
    console.error("FAIL: src/log.test.mjs must reference `verbose`.");
    process.exit(1);
  }

  // (2b) tests must pass
  const r = spawnSync(process.execPath, ["--test", "src/log.test.mjs"], {
    cwd: here,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("FAIL: src/log.test.mjs has failing tests.");
    process.exit(1);
  }

  console.log("PASS: multistep-config-then-test");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
