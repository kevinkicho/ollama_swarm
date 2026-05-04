// T197 (2026-05-04): tests for the import-graph helper. Pure-function
// coverage; on-disk path (buildImportGraph) gets one integration test
// against a temp dir.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractImportPaths,
  extractPythonImportPaths,
  extractRustImportPaths,
  extractGoImportPaths,
  buildBidirectionalGraph,
  buildImportGraph,
  clusterByImports,
  relatedFilesViaImports,
  type ImportGraph,
} from "./importGraph.js";

describe("extractImportPaths — pure", () => {
  const knownFiles = new Set([
    "src/foo.ts",
    "src/bar.ts",
    "src/baz/index.ts",
    "src/qux.tsx",
  ]);

  it("matches named ES imports with relative paths", () => {
    const text = `import { x } from "./bar";`;
    assert.deepEqual(
      extractImportPaths(text, "src/foo.ts", knownFiles),
      ["src/bar.ts"],
    );
  });

  it("matches dynamic imports", () => {
    const text = `const m = await import("./bar");`;
    assert.deepEqual(
      extractImportPaths(text, "src/foo.ts", knownFiles),
      ["src/bar.ts"],
    );
  });

  it("matches re-exports", () => {
    const text = `export { x } from "./bar";`;
    assert.deepEqual(
      extractImportPaths(text, "src/foo.ts", knownFiles),
      ["src/bar.ts"],
    );
  });

  it("matches side-effect imports", () => {
    const text = `import "./bar";`;
    assert.deepEqual(
      extractImportPaths(text, "src/foo.ts", knownFiles),
      ["src/bar.ts"],
    );
  });

  it("resolves directory imports via /index.ts", () => {
    const text = `import { z } from "./baz";`;
    assert.deepEqual(
      extractImportPaths(text, "src/foo.ts", knownFiles),
      ["src/baz/index.ts"],
    );
  });

  it("skips bare specifiers (lodash, node:fs, etc.)", () => {
    const text = `import { x } from "lodash";\nimport fs from "node:fs";`;
    assert.deepEqual(
      extractImportPaths(text, "src/foo.ts", knownFiles),
      [],
    );
  });

  it("skips self-imports", () => {
    const text = `import { x } from "./foo";`;
    // foo importing foo (resolves to src/foo.ts, same as input) → skipped
    assert.deepEqual(
      extractImportPaths(text, "src/foo.ts", knownFiles),
      [],
    );
  });

  it("dedupes same-target imports", () => {
    const text = `import { a } from "./bar";\nimport type { b } from "./bar";`;
    assert.deepEqual(
      extractImportPaths(text, "src/foo.ts", knownFiles),
      ["src/bar.ts"],
    );
  });

  it("returns empty when no imports present", () => {
    assert.deepEqual(
      extractImportPaths("export const x = 1;", "src/foo.ts", knownFiles),
      [],
    );
  });

  it("skips paths that don't resolve to any known file", () => {
    const text = `import { x } from "./does-not-exist";`;
    assert.deepEqual(
      extractImportPaths(text, "src/foo.ts", knownFiles),
      [],
    );
  });
});

describe("extractPythonImportPaths — pure", () => {
  const knownFiles = new Set([
    "src/foo.py",
    "src/bar.py",
    "src/sub/__init__.py",
    "src/sub/baz.py",
    "tests/test_foo.py",
  ]);

  it("matches relative import (single dot)", () => {
    const text = `from . import bar`;
    assert.deepEqual(
      extractPythonImportPaths(text, "src/foo.py", knownFiles),
      ["src/bar.py"],
    );
  });

  it("matches relative-from-package import", () => {
    const text = `from .sub import baz`;
    const out = extractPythonImportPaths(text, "src/foo.py", knownFiles);
    // Should resolve to src/sub/__init__.py (the package init)
    assert.ok(out.includes("src/sub/__init__.py") || out.includes("src/sub/baz.py"));
  });

  it("matches up-level relative import", () => {
    const text = `from ..foo import x`;
    assert.deepEqual(
      extractPythonImportPaths(text, "src/sub/baz.py", knownFiles),
      ["src/foo.py"],
    );
  });

  it("skips standard library imports", () => {
    const text = `import os\nfrom typing import List`;
    assert.deepEqual(
      extractPythonImportPaths(text, "src/foo.py", knownFiles),
      [],
    );
  });

  it("matches absolute intra-package import via path probing", () => {
    const text = `from src.bar import x`;
    const out = extractPythonImportPaths(text, "src/foo.py", knownFiles);
    assert.ok(out.includes("src/bar.py"));
  });

  it("returns empty for file with no imports", () => {
    assert.deepEqual(
      extractPythonImportPaths("def hello(): pass", "src/foo.py", knownFiles),
      [],
    );
  });
});

describe("buildBidirectionalGraph — pure", () => {
  it("returns empty graph for empty input", () => {
    const empty: ImportGraph = new Map();
    assert.equal(buildBidirectionalGraph(empty).size, 0);
  });

  it("adds reverse edges", () => {
    const g: ImportGraph = new Map([
      ["a.ts", new Set(["b.ts"])],
      ["b.ts", new Set()],
    ]);
    const bi = buildBidirectionalGraph(g);
    assert.ok(bi.get("a.ts")?.has("b.ts"));
    assert.ok(bi.get("b.ts")?.has("a.ts"));
  });
});

describe("relatedFilesViaImports — pure", () => {
  it("finds 1-hop neighbors (importers + importees)", () => {
    const g: ImportGraph = new Map([
      ["a.ts", new Set(["b.ts", "c.ts"])],
      ["b.ts", new Set()],
      ["c.ts", new Set(["d.ts"])],
      ["d.ts", new Set()],
    ]);
    const related = relatedFilesViaImports("c.ts", g);
    // c imports d; a imports c → both a and d are 1-hop related.
    assert.ok(related.includes("a.ts"));
    assert.ok(related.includes("d.ts"));
    assert.equal(related.length, 2);
  });

  it("returns empty for a file with no edges", () => {
    const g: ImportGraph = new Map([["isolated.ts", new Set()]]);
    assert.deepEqual(relatedFilesViaImports("isolated.ts", g), []);
  });

  it("respects cap", () => {
    const edges = new Set(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    const g: ImportGraph = new Map([["root.ts", edges]]);
    assert.equal(relatedFilesViaImports("root.ts", g, 2).length, 2);
  });
});

describe("clusterByImports — pure", () => {
  it("returns k empty buckets for empty input", () => {
    const buckets = clusterByImports([], new Map(), 3);
    assert.equal(buckets.length, 3);
    for (const b of buckets) assert.equal(b.length, 0);
  });

  it("balances bucket sizes within ±1 for graphs with no edges", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g"];
    const g: ImportGraph = new Map(files.map((f) => [f, new Set()]));
    const buckets = clusterByImports(files, g, 3);
    const sizes = buckets.map((b) => b.length);
    const max = Math.max(...sizes);
    const min = Math.min(...sizes);
    assert.ok(max - min <= 1, `bucket sizes too lopsided: ${sizes.join(",")}`);
  });

  it("groups connected components into the same bucket", () => {
    // a→b→c (connected component); d, e isolated.
    const g: ImportGraph = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set()],
      ["d", new Set()],
      ["e", new Set()],
    ]);
    const buckets = clusterByImports(["a", "b", "c", "d", "e"], g, 3);
    // a, b, c should all be in the SAME bucket.
    const bucketOf = new Map<string, number>();
    for (let i = 0; i < buckets.length; i++) {
      for (const f of buckets[i]!) bucketOf.set(f, i);
    }
    assert.equal(bucketOf.get("a"), bucketOf.get("b"));
    assert.equal(bucketOf.get("b"), bucketOf.get("c"));
  });
});

describe("buildImportGraph — on-disk roundtrip", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "import-graph-"));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("walks repo files + builds a forward-edge graph", async () => {
    mkdirSync(join(workdir, "src"));
    writeFileSync(join(workdir, "src", "a.ts"), `import { x } from "./b";`);
    writeFileSync(join(workdir, "src", "b.ts"), `export const x = 1;`);
    writeFileSync(
      join(workdir, "src", "c.ts"),
      `import { x } from "./a";\nimport "./b";`,
    );
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const g = await buildImportGraph(workdir, files);
    assert.deepEqual([...g.get("src/a.ts")!], ["src/b.ts"]);
    assert.deepEqual([...g.get("src/b.ts")!], []);
    assert.deepEqual([...g.get("src/c.ts")!].sort(), ["src/a.ts", "src/b.ts"]);
  });

  it("non-TS/JS files get empty edges (no parse attempt)", async () => {
    writeFileSync(join(workdir, "README.md"), `import { x } from "./foo";`);
    const g = await buildImportGraph(workdir, ["README.md"]);
    assert.deepEqual([...g.get("README.md")!], []);
  });

  it("file read failure → empty edges (best-effort)", async () => {
    // listed but not on disk — read fails
    const g = await buildImportGraph(workdir, ["src/missing.ts"]);
    assert.deepEqual([...g.get("src/missing.ts")!], []);
  });
});

// T-Item-Lang (2026-05-04): Rust import extractor tests
describe("extractRustImportPaths — pure", () => {
  const knownFiles = new Set([
    "src/lib.rs",
    "src/foo.rs",
    "src/bar/mod.rs",
    "src/bar/baz.rs",
    "src/util.rs",
  ]);

  it("captures `mod foo;` → src/foo.rs", () => {
    const text = `mod foo;\nmod bar;`;
    const got = extractRustImportPaths(text, "src/lib.rs", knownFiles);
    assert.ok(got.includes("src/foo.rs"));
    assert.ok(got.includes("src/bar/mod.rs"));
  });

  it("captures `use crate::foo;` → src/foo.rs", () => {
    const text = `use crate::foo;`;
    const got = extractRustImportPaths(text, "src/bar/mod.rs", knownFiles);
    assert.ok(got.includes("src/foo.rs"));
  });

  it("captures `use super::util;` → resolves up one level", () => {
    const text = `use super::util;`;
    const got = extractRustImportPaths(text, "src/bar/mod.rs", knownFiles);
    assert.ok(got.includes("src/util.rs"));
  });

  it("captures `use self::baz;` → relative within current dir", () => {
    const text = `use self::baz;`;
    const got = extractRustImportPaths(text, "src/bar/mod.rs", knownFiles);
    assert.ok(got.includes("src/bar/baz.rs"));
  });

  it("skips `use std::*` (standard library)", () => {
    const text = `use std::collections::HashMap;\nuse core::option::Option;`;
    const got = extractRustImportPaths(text, "src/lib.rs", knownFiles);
    assert.equal(got.length, 0);
  });

  it("skips external crates (unresolvable paths)", () => {
    const text = `use serde::Deserialize;\nuse tokio::sync::Mutex;`;
    const got = extractRustImportPaths(text, "src/lib.rs", knownFiles);
    assert.equal(got.length, 0);
  });

  it("does not include self-imports", () => {
    const text = `use crate::lib;`;
    // crate::lib resolves to src/lib.rs which IS the file itself
    const got = extractRustImportPaths(text, "src/lib.rs", knownFiles);
    assert.ok(!got.includes("src/lib.rs"));
  });

  it("handles `pub use` and `pub mod` keywords", () => {
    const text = `pub mod foo;\npub use crate::util;`;
    const got = extractRustImportPaths(text, "src/lib.rs", knownFiles);
    assert.ok(got.includes("src/foo.rs"));
    assert.ok(got.includes("src/util.rs"));
  });

  it("dedupes when same target imported multiple times", () => {
    const text = `use crate::foo;\nuse crate::foo::Bar;`;
    const got = extractRustImportPaths(text, "src/lib.rs", knownFiles);
    const fooCount = got.filter((p) => p === "src/foo.rs").length;
    assert.equal(fooCount, 1);
  });

  it("returns empty list when input has no imports", () => {
    const text = `fn main() { println!(\"hello\"); }`;
    const got = extractRustImportPaths(text, "src/lib.rs", knownFiles);
    assert.deepEqual(got, []);
  });
});

// T-Item-Lang (2026-05-04): Go import extractor tests
describe("extractGoImportPaths — pure", () => {
  const knownFiles = new Set([
    "main.go",
    "internal/foo/foo.go",
    "internal/foo/foo_test.go",
    "internal/bar/bar.go",
    "pkg/util/util.go",
  ]);

  it("captures single `import \"path\"` form", () => {
    const text = `package main\n\nimport "internal/foo"`;
    const got = extractGoImportPaths(text, "main.go", knownFiles);
    assert.ok(got.includes("internal/foo/foo.go"));
  });

  it("captures grouped `import ( ... )` form", () => {
    const text = [
      `package main`,
      ``,
      `import (`,
      `  "internal/foo"`,
      `  "internal/bar"`,
      `  "pkg/util"`,
      `)`,
    ].join("\n");
    const got = extractGoImportPaths(text, "main.go", knownFiles);
    assert.ok(got.includes("internal/foo/foo.go"));
    assert.ok(got.includes("internal/bar/bar.go"));
    assert.ok(got.includes("pkg/util/util.go"));
  });

  it("handles aliased imports (`alias \"path\"`)", () => {
    const text = `package main\n\nimport f "internal/foo"`;
    const got = extractGoImportPaths(text, "main.go", knownFiles);
    assert.ok(got.includes("internal/foo/foo.go"));
  });

  it("strips module prefix heuristic (github.com/owner/repo/...)", () => {
    const text = `package main\n\nimport "github.com/owner/repo/internal/foo"`;
    const got = extractGoImportPaths(text, "main.go", knownFiles);
    assert.ok(got.includes("internal/foo/foo.go"));
  });

  it("ignores commented-out imports", () => {
    const text = [
      `package main`,
      `// import "internal/foo"`,
      `/* import "internal/bar" */`,
      `import "pkg/util"`,
    ].join("\n");
    const got = extractGoImportPaths(text, "main.go", knownFiles);
    // Only the un-commented import should be captured
    assert.ok(got.includes("pkg/util/util.go"));
    assert.equal(got.includes("internal/foo/foo.go"), false);
    assert.equal(got.includes("internal/bar/bar.go"), false);
  });

  it("picks the alphabetically-first .go file in a directory (deterministic)", () => {
    const knownPair = new Set([
      "main.go",
      "internal/x/a.go",
      "internal/x/b.go",
    ]);
    const text = `import "internal/x"`;
    const got = extractGoImportPaths(text, "main.go", knownPair);
    assert.ok(got.includes("internal/x/a.go"));
    assert.equal(got.includes("internal/x/b.go"), false);
  });

  it("does not include self-imports", () => {
    const text = `import "internal/foo"`;
    const got = extractGoImportPaths(text, "internal/foo/foo.go", knownFiles);
    // foo.go is in internal/foo dir; the import resolves to internal/foo/foo.go
    // which IS the source file itself
    assert.ok(!got.includes("internal/foo/foo.go"));
  });

  it("returns empty list when no imports", () => {
    const text = `package main\n\nfunc main() {}`;
    const got = extractGoImportPaths(text, "main.go", knownFiles);
    assert.deepEqual(got, []);
  });

  it("dedupes when same import appears twice", () => {
    const text = [
      `package main`,
      `import "internal/foo"`,
      `import "internal/foo"`,
    ].join("\n");
    const got = extractGoImportPaths(text, "main.go", knownFiles);
    assert.equal(got.filter((p) => p === "internal/foo/foo.go").length, 1);
  });

  it("skips bare standard-library imports (unresolvable)", () => {
    const text = `import "fmt"\nimport "os"`;
    const got = extractGoImportPaths(text, "main.go", knownFiles);
    // fmt + os won't resolve to anything in knownFiles
    assert.equal(got.length, 0);
  });
});
