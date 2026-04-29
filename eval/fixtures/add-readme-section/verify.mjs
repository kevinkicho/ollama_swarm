#!/usr/bin/env node
// Verify command for the add-readme-section fixture. Reads README.md
// and confirms a `## Usage` heading is present. Exits 0 on success,
// 1 on missing.

import { readFileSync } from "node:fs";

try {
  const md = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  if (!/^## Usage\b/m.test(md)) {
    console.error("FAIL: README.md is missing a `## Usage` heading.");
    process.exit(1);
  }
  // Mild content gate: require at least one line of content under the
  // heading so an empty header doesn't pass.
  const after = md.split(/^## Usage\b/m)[1] ?? "";
  const meaningful = after.split("\n").slice(1).join("\n").trim();
  if (meaningful.length < 10) {
    console.error("FAIL: `## Usage` heading exists but the section is empty.");
    process.exit(1);
  }
  console.log("PASS: add-readme-section");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
