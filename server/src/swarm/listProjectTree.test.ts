import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listProjectTreeSync,
  pathStaysUnderRoot,
} from "./councilPromptHelpers.js";
import { realpathSync } from "node:fs";

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

  it("skips symlink directories (does not list outside root)", () => {
    const root = mkdtempSync(join(tmpdir(), "proj-tree-sym-"));
    const outside = mkdtempSync(join(tmpdir(), "proj-outside-"));
    try {
      writeFileSync(join(outside, "secret.ts"), "export {};\n");
      writeFileSync(join(root, "local.ts"), "export {};\n");
      try {
        symlinkSync(outside, join(root, "linked"), "junction");
      } catch {
        // Symlinks may require privileges on some Windows hosts — skip then.
        return;
      }
      const { files, dirs } = listProjectTreeSync(root, {
        maxDirs: 20,
        maxFiles: 20,
      });
      assert.ok(files.some((f) => f.includes("local.ts")));
      assert.ok(!files.some((f) => f.includes("secret.ts")));
      assert.ok(!dirs.some((d) => d.includes("linked")));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("respects maxDepth", () => {
    const root = mkdtempSync(join(tmpdir(), "proj-tree-depth-"));
    try {
      mkdirSync(join(root, "a", "b", "c"), { recursive: true });
      writeFileSync(join(root, "a", "b", "c", "deep.ts"), "export {};\n");
      writeFileSync(join(root, "top.ts"), "export {};\n");
      const { files } = listProjectTreeSync(root, {
        maxDirs: 50,
        maxFiles: 50,
        maxDepth: 1,
      });
      assert.ok(files.some((f) => f.includes("top.ts")));
      assert.ok(!files.some((f) => f.includes("deep.ts")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pathStaysUnderRoot accepts children and rejects siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "proj-contain-"));
    const sibling = mkdtempSync(join(tmpdir(), "proj-sibling-"));
    try {
      writeFileSync(join(root, "a.ts"), "export {};\n");
      writeFileSync(join(sibling, "b.ts"), "export {};\n");
      const rootReal = realpathSync(root);
      assert.equal(pathStaysUnderRoot(rootReal, join(root, "a.ts")), true);
      assert.equal(pathStaysUnderRoot(rootReal, join(sibling, "b.ts")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
