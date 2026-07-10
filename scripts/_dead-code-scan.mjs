// One-shot dead-code scan: never-imported modules + exports only used in tests.
import fs from "fs";
import path from "path";

const roots = ["server/src", "shared/src", "web/src"];
const EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const skipDir = new Set(["node_modules", "dist", ".git"]);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDir.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(ent.name))) out.push(path.resolve(p));
  }
  return out;
}

const files = roots.flatMap((r) => (fs.existsSync(r) ? walk(r) : []));
const importRe =
  /from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const allContent = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  let cleaned = spec;
  if (cleaned.endsWith(".js")) cleaned = cleaned.slice(0, -3);
  const base = path.resolve(path.dirname(fromFile), cleaned);
  const cands = [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".js",
    base + ".mjs",
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
  ];
  for (const c of cands) {
    if (allContent.has(c)) return c;
  }
  return null;
}

const importedBy = new Map(files.map((f) => [f, new Set()]));
for (const [f, src] of allContent) {
  let m;
  importRe.lastIndex = 0;
  while ((m = importRe.exec(src))) {
    const spec = m[1] || m[2] || m[3];
    const r = resolveImport(f, spec);
    if (r) importedBy.get(r).add(f);
  }
}

const entryBasenames = new Set([
  "index.ts",
  "main.tsx",
  "App.tsx",
  "config.ts",
  "env.d.ts",
]);
const entryPaths = new Set(
  files.filter((f) => {
    const base = path.basename(f);
    const rel = path.relative(process.cwd(), f).replace(/\\/g, "/");
    return (
      entryBasenames.has(base) &&
      (rel.endsWith("server/src/index.ts") ||
        rel.endsWith("web/src/main.tsx") ||
        rel.endsWith("web/src/App.tsx") ||
        rel.endsWith("shared/src/index.ts") ||
        rel.endsWith("server/src/config.ts") ||
        rel.endsWith("web/src/env.d.ts"))
    );
  }),
);

function isTest(f) {
  const b = path.basename(f);
  return b.includes(".test.") || b.includes(".spec.");
}

function rel(f) {
  return path.relative(process.cwd(), f).replace(/\\/g, "/");
}

const neverImported = [];
const onlyTests = [];
for (const f of files) {
  if (isTest(f)) continue;
  if (entryPaths.has(f)) continue;
  // vite worker entry
  if (f.endsWith("buildContext.worker.ts")) continue;
  const importers = [...(importedBy.get(f) || [])];
  if (importers.length === 0) {
    neverImported.push(rel(f));
    continue;
  }
  if (importers.every(isTest)) onlyTests.push(rel(f));
}

// Export-level: export function/const that never appears elsewhere outside defining file
const exportRe =
  /export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)\s*=|export\s+(?:type|interface|class|enum)\s+(\w+)/g;
const exportHits = [];
for (const [f, src] of allContent) {
  if (isTest(f)) continue;
  let m;
  exportRe.lastIndex = 0;
  while ((m = exportRe.exec(src))) {
    const name = m[1] || m[2] || m[3];
    if (!name || name === "default") continue;
    // skip type-only noise somewhat: still count
    let found = false;
    let onlyInTests = true;
    for (const [of, osrc] of allContent) {
      if (of === f) continue;
      // rough: word boundary name usage
      if (new RegExp(`\\b${name}\\b`).test(osrc)) {
        found = true;
        if (!isTest(of)) onlyInTests = false;
      }
    }
    if (!found) {
      exportHits.push({ kind: "never", name, file: rel(f) });
    } else if (onlyInTests) {
      exportHits.push({ kind: "test-only", name, file: rel(f) });
    }
  }
}

console.log("=== NEVER-IMPORTED MODULES (non-test) ===");
neverImported.sort().forEach((f) => console.log(f));
console.log("count:", neverImported.length);

console.log("\n=== MODULES ONLY IMPORTED BY TESTS ===");
onlyTests.sort().forEach((f) => console.log(f));
console.log("count:", onlyTests.length);

const neverExports = exportHits.filter((e) => e.kind === "never");
const testOnlyExports = exportHits.filter((e) => e.kind === "test-only");
console.log("\n=== NEVER-REFERENCED EXPORTS (heuristic) ===");
// group by file, show first 80
neverExports
  .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))
  .slice(0, 100)
  .forEach((e) => console.log(`${e.file} :: ${e.name}`));
console.log("count never-ref exports:", neverExports.length, "(showing up to 100)");

console.log("\n=== TEST-ONLY EXPORTS (heuristic, sample) ===");
testOnlyExports
  .sort((a, b) => a.file.localeCompare(b.file))
  .slice(0, 40)
  .forEach((e) => console.log(`${e.file} :: ${e.name}`));
console.log("count test-only exports:", testOnlyExports.length);

// Write JSON report for follow-up
const report = {
  neverImported,
  onlyTests,
  neverExports: neverExports.slice(0, 300),
  testOnlyExports: testOnlyExports.slice(0, 200),
  totals: {
    files: files.length,
    neverImported: neverImported.length,
    onlyTests: onlyTests.length,
    neverExports: neverExports.length,
    testOnlyExports: testOnlyExports.length,
  },
};
fs.writeFileSync("scripts/_dead-code-report.json", JSON.stringify(report, null, 2));
console.log("\nWrote scripts/_dead-code-report.json");
