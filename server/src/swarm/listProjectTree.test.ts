import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listProjectTreeSync } from "./councilPromptHelpers.js";

describe("listProjectTreeSync", () => {
  it("lists dirs and code files without Unix find", () => {
    const root = mkdtempSync(join(tmpdir(), "proj-tree-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "main.ts"), "export {};\n");
      writeFileSync(join(root, "package.json"), "{}\n");
      mkdirSync(join(root, "node_modules", "x"), { recursive: true });
      writeFileSync(join(root, "node_modules", "x", "index.js"), "");
      const { dirs, files } = listProjectTreeSync(root, {
        maxDirs: 20,
        maxFiles: 20,
      });
      assert.ok(dirs.some((d) => d.includes("src")));
      assert.ok(files.some((f) => f.includes("main.ts")));
      assert.ok(files.some((f) => f.includes("package.json")));
      assert.ok(!files.some((f) => f.includes("node_modules")));
      assert.ok(!dirs.some((d) => d.includes("node_modules")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
