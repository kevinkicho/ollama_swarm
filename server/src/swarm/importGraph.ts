// T197 (2026-05-04) + T199 multi-language extension (2026-05-04) +
// T-Item-Lang (2026-05-04, this session): import-graph extraction.
//
// Regex-based — ts-morph / tree-sitter would be more accurate but
// would add a heavy dep. The regex version covers the common cases
// for four languages today: TypeScript/JavaScript (T197), Python
// (T199), Rust + Go (T-Item-Lang). Other languages still skipped
// silently — they'd benefit from a real AST parser.
//
// Two consumers:
//   1. map-reduce smart slicing — groups files that import each
//      other into the same mapper slice
//   2. stigmergy cross-cluster discovery — when an explorer surfaces
//      a finding, plants pheromones on related files
//
// EXPLICIT GAPS — call them out in PRs that touch this file:
//   - Other languages (Java, C, C++, Ruby, etc.): skipped silently.
//   - Dynamic imports `import("./x")` (TS) detected but unresolved
//     when path is a runtime expression.
//   - Re-exports `export { x } from "./y"` (TS) detected.
//   - Bare specifiers (`from "lodash"`, `import os`) skipped — we
//     only care about intra-repo edges.
//   - Path aliases (`@/foo` from tsconfig.json) skipped — caller
//     would need to inject the alias map.
//   - Python relative imports (`from . import x`, `from .foo import bar`)
//     detected; absolute intra-package imports (`from myapp.sub import x`)
//     attempted via path probing but may miss when package layout is
//     non-standard.

import { promises as fs } from "node:fs";
import path from "node:path";

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PYTHON_EXTS = new Set([".py", ".pyi"]);
const RUST_EXTS = new Set([".rs"]);
const GO_EXTS = new Set([".go"]);

/** Repo-relative file path → list of repo-relative paths it imports.
 *  Bare specifiers (`lodash`, `node:fs`) are excluded. Self-imports
 *  excluded. Edges are uni-directional; the caller composes the
 *  bidirectional view via `buildBidirectionalGraph`. */
export type ImportGraph = Map<string, Set<string>>;

/** Extract import edges from a single TS/JS file's text. Pure —
 *  exported for tests. Returns repo-relative paths (resolved against
 *  the file's directory + tried with common extensions). Bare
 *  specifiers + unresolvable paths silently dropped. */
export function extractImportPaths(
  fileText: string,
  filePathRelToRepo: string,
  knownFiles: ReadonlySet<string>,
): string[] {
  // Match: import X from "./y", import "..." from '...', export { ... } from '...',
  //        import("./y") (dynamic).
  // Captures the quoted string. Permissive on whitespace.
  const re = /(?:^|[\s;])(?:import|export)\s+(?:[\s\S]+?\s+from\s+)?["']([^"']+)["']/g;
  const dynRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  const fileDir = path.posix.dirname(toPosix(filePathRelToRepo));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of [...fileText.matchAll(re), ...fileText.matchAll(dynRe)]) {
    const spec = m[1]!;
    // Skip bare specifiers — anything not starting with "." or "/"
    if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
    // Resolve relative to the file's dir (POSIX paths since we're in
    // repo-relative space; convert at the end if needed).
    const resolvedRaw = path.posix.normalize(path.posix.join(fileDir, spec));
    const resolved = tryResolveExtensions(resolvedRaw, knownFiles);
    if (!resolved) continue;
    if (resolved === toPosix(filePathRelToRepo)) continue; // no self-imports
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** Try matching a path with no extension against the known-files set
 *  using the common TS/JS extensions. Returns the matched form, or
 *  null when nothing matches. */
function tryResolveExtensions(
  basePath: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  // 1. Exact match (already includes extension)
  if (knownFiles.has(basePath)) return basePath;
  // 2. Try common extensions
  for (const ext of TS_JS_EXTS) {
    const candidate = basePath + ext;
    if (knownFiles.has(candidate)) return candidate;
  }
  // 3. Try /index.<ext>
  for (const ext of TS_JS_EXTS) {
    const candidate = path.posix.join(basePath, `index${ext}`);
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** T199 (2026-05-04): Python import extractor. Handles relative
 *  imports (`from . import x`, `from .foo import bar`, `from ..foo
 *  import bar`) + absolute intra-package imports (`from myapp.sub
 *  import x`) via best-effort path probing against the known-files
 *  set. Returns repo-relative paths. Bare specifiers (`import os`,
 *  `from typing import List`) silently dropped. Pure — exported
 *  for tests. */
export function extractPythonImportPaths(
  fileText: string,
  filePathRelToRepo: string,
  knownFiles: ReadonlySet<string>,
): string[] {
  const filePosix = toPosix(filePathRelToRepo);
  const fileDir = path.posix.dirname(filePosix);
  const out: string[] = [];
  const seen = new Set<string>();
  // Pattern 1: `from .foo import bar` or `from ..foo import bar`
  // OR `from . import bar` (relative import where bar is a submodule
  // of the current package). Captures the dot-prefix + optional
  // module name + the post-import names list.
  const relRe = /^[\s]*from\s+(\.+)([a-zA-Z_][\w.]*)?\s+import\s+([a-zA-Z_][\w,\s.]*)/gm;
  // Pattern 2: `from foo.bar import x` (absolute). Captures the dotted module.
  const absRe = /^[\s]*from\s+([a-zA-Z_][\w.]*)\s+import\s+/gm;
  // Pattern 3: `import foo.bar` or `import foo` (rare for intra-repo
  // since most code does `from x import y`).
  const plainRe = /^[\s]*import\s+([a-zA-Z_][\w.]*)\s*$/gm;

  // Helper: try to resolve a dotted module to a known file.
  const tryResolve = (basePath: string): string | null => {
    // Try basePath.py + basePath/__init__.py
    const py = basePath + ".py";
    if (knownFiles.has(py)) return py;
    const pyi = basePath + ".pyi";
    if (knownFiles.has(pyi)) return pyi;
    const init = path.posix.join(basePath, "__init__.py");
    if (knownFiles.has(init)) return init;
    return null;
  };
  const consider = (resolved: string | null) => {
    if (!resolved) return;
    if (resolved === filePosix) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };
  // Relative imports
  for (const m of fileText.matchAll(relRe)) {
    const dots = m[1]!;
    const mod = m[2] ?? "";
    const importedRaw = m[3] ?? "";
    // dots count = N means "go up (N-1) levels then down"
    const upLevels = dots.length - 1;
    let baseDir = fileDir;
    for (let i = 0; i < upLevels; i++) baseDir = path.posix.dirname(baseDir);
    const modPath = mod ? mod.replace(/\./g, "/") : "";
    const basePath = modPath ? path.posix.join(baseDir, modPath) : baseDir;
    // First try to resolve `<basePath>.py` / `<basePath>/__init__.py`
    // (the module/package being imported FROM).
    const resolved = tryResolve(basePath);
    if (resolved) {
      consider(resolved);
    }
    // ALSO try each post-import name as a SUBMODULE of basePath. Handles
    // `from . import bar` where bar is a sibling file. Names list may
    // contain commas (`from . import a, b`) — split + try each.
    const importedNames = importedRaw
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
      .filter((s) => s.length > 0 && /^[a-zA-Z_][\w.]*$/.test(s));
    for (const name of importedNames) {
      const subPath = path.posix.join(basePath, name);
      consider(tryResolve(subPath));
    }
  }
  // Absolute imports — try interpreting the dotted module as a path
  // relative to the repo root + walk up from the file's dir trying
  // common Python source roots (package root inferred by presence of
  // __init__.py; we just probe both repo-root and parent dirs).
  for (const m of fileText.matchAll(absRe)) {
    const mod = m[1]!;
    const modPath = mod.replace(/\./g, "/");
    // Try several roots: repo root, then each parent of file's dir.
    const candidates: string[] = [modPath];
    let cur = fileDir;
    while (cur !== "" && cur !== ".") {
      candidates.push(path.posix.join(cur, modPath));
      cur = path.posix.dirname(cur);
    }
    for (const c of candidates) {
      const resolved = tryResolve(c);
      if (resolved) {
        consider(resolved);
        break; // first match wins to avoid duplicate edges
      }
    }
  }
  // Plain imports
  for (const m of fileText.matchAll(plainRe)) {
    const mod = m[1]!;
    const modPath = mod.replace(/\./g, "/");
    const candidates: string[] = [modPath];
    let cur = fileDir;
    while (cur !== "" && cur !== ".") {
      candidates.push(path.posix.join(cur, modPath));
      cur = path.posix.dirname(cur);
    }
    for (const c of candidates) {
      const resolved = tryResolve(c);
      if (resolved) {
        consider(resolved);
        break;
      }
    }
  }
  return out;
}

/** T-Item-Lang (2026-05-04): Rust import extractor. Handles:
 *   - `use foo::bar;` — absolute path within current crate
 *   - `use crate::foo::bar;` — explicit crate root anchor
 *   - `use super::bar;` / `use self::bar;` — relative to current module
 *   - `mod foo;` — declares a submodule (resolves to `foo.rs` or `foo/mod.rs`)
 *
 *  Path resolution for `use` statements is best-effort: Rust modules
 *  can live in `<name>.rs` OR `<name>/mod.rs` OR `<name>/<file>.rs`.
 *  We probe both common layouts. External crates (`use serde::...`)
 *  are skipped — we only care about intra-repo edges, and recognizing
 *  external crates without a Cargo.toml parse is unreliable.
 *  Heuristic: `use std::...`, `use core::...`, `use alloc::...` and
 *  any single-segment path with no `::` (already handled by the
 *  regex) are treated as candidates; if path resolution fails, the
 *  edge is dropped. Pure — exported for tests. */
export function extractRustImportPaths(
  fileText: string,
  filePathRelToRepo: string,
  knownFiles: ReadonlySet<string>,
): string[] {
  const filePosix = toPosix(filePathRelToRepo);
  const fileDir = path.posix.dirname(filePosix);
  const out: string[] = [];
  const seen = new Set<string>();
  // Only treat resolutions matching this set as our crate. External
  // crates (std, serde, etc.) live outside the repo so their resolves
  // will fail naturally; this list documents the common standard-lib
  // roots we KNOW to skip without probing.
  const STD_ROOTS = new Set(["std", "core", "alloc", "test", "proc_macro"]);

  // Helper: try to resolve a Rust path string to a known file.
  const tryResolveRust = (basePath: string): string | null => {
    const rs = basePath + ".rs";
    if (knownFiles.has(rs)) return rs;
    const modRs = path.posix.join(basePath, "mod.rs");
    if (knownFiles.has(modRs)) return modRs;
    return null;
  };
  const consider = (resolved: string | null) => {
    if (!resolved) return;
    if (resolved === filePosix) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };
  // Find the crate root by walking up from fileDir. Probes both
  // `<cur>/src/lib.rs` (standard cargo layout where cur is the crate
  // root containing Cargo.toml) AND `<cur>/lib.rs` (cur IS already the
  // src dir). First match wins. Falls back to the file's own dir when
  // nothing matches (single-file scripts / non-cargo layout).
  const findCrateRoot = (): string => {
    let cur = fileDir;
    while (true) {
      // Cargo layout: <cur>/src/{lib,main}.rs → crate root is <cur>/src
      if (
        knownFiles.has(path.posix.join(cur, "src", "lib.rs")) ||
        knownFiles.has(path.posix.join(cur, "src", "main.rs"))
      ) {
        return path.posix.join(cur, "src");
      }
      // cur IS the src dir already
      if (
        knownFiles.has(path.posix.join(cur, "lib.rs")) ||
        knownFiles.has(path.posix.join(cur, "main.rs"))
      ) {
        return cur;
      }
      const parent = path.posix.dirname(cur);
      if (parent === cur || parent === ".") break;
      cur = parent;
    }
    return fileDir;
  };
  const crateRoot = findCrateRoot();

  // Pattern 1: `mod foo;` — declares a submodule. The module's file
  // lives at `<currentDir>/foo.rs` or `<currentDir>/foo/mod.rs`.
  const modRe = /^[\s]*(?:pub\s+)?mod\s+([a-zA-Z_][\w]*)\s*;/gm;
  for (const m of fileText.matchAll(modRe)) {
    const name = m[1]!;
    consider(tryResolveRust(path.posix.join(fileDir, name)));
  }
  // Pattern 2: `use ...::...;` — captures the path between `use` and
  // either a brace block (`use foo::{a, b};`) or `;`. Path segments
  // are joined by `::`. We only consider the path PREFIX up to the
  // first brace or `as` rename.
  const useRe = /^[\s]*(?:pub\s+)?use\s+([a-zA-Z_][\w:]*)/gm;
  for (const m of fileText.matchAll(useRe)) {
    const pathExpr = m[1]!;
    const segments = pathExpr.split("::").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    if (STD_ROOTS.has(segments[0])) continue;
    // Resolve the path's BASE (the directory + module-name part). For
    // `use crate::foo::Bar`, the file is `<crateRoot>/foo.rs` (Bar is
    // a symbol INSIDE that file). For `use crate::foo::bar::Baz`, the
    // file could be `<crateRoot>/foo/bar.rs` OR `<crateRoot>/foo/bar/mod.rs`
    // (Baz is the symbol). We probe with successive trailing trims
    // (drop 0, 1, 2, ... trailing segments) until we find a real file.
    let baseSegments: string[];
    let anchorDir: string;
    if (segments[0] === "crate") {
      anchorDir = crateRoot;
      baseSegments = segments.slice(1);
    } else if (segments[0] === "super") {
      // Each consecutive `super` walks one dir up
      let cur = fileDir;
      let i = 0;
      while (i < segments.length && segments[i] === "super") {
        cur = path.posix.dirname(cur);
        i++;
      }
      anchorDir = cur;
      baseSegments = segments.slice(i);
    } else if (segments[0] === "self") {
      anchorDir = fileDir;
      baseSegments = segments.slice(1);
    } else {
      // Bare path — assume intra-crate via crate root (default in 2018+ Rust).
      anchorDir = crateRoot;
      baseSegments = segments;
    }
    if (baseSegments.length === 0) continue;
    // Try with all segments, then drop trailing 1, 2, ... until we hit a file
    let resolvedFinal: string | null = null;
    for (let drop = 0; drop < baseSegments.length; drop++) {
      const remaining = baseSegments.slice(0, baseSegments.length - drop);
      const candidate = path.posix.join(anchorDir, ...remaining);
      resolvedFinal = tryResolveRust(candidate);
      if (resolvedFinal) break;
    }
    consider(resolvedFinal);
  }
  return out;
}

/** T-Item-Lang (2026-05-04): Go import extractor. Handles:
 *   - `import "path/to/pkg"` — single import
 *   - `import (` … `)` — grouped imports
 *
 *  Go imports are strings; the import path's last segment is usually
 *  the package name. Intra-repo imports look like `<module>/foo/bar`
 *  where <module> is the go.mod's module declaration. We don't parse
 *  go.mod (heavy work) — instead, we strip the suspected module
 *  prefix by probing: for each import path, try interpreting it as
 *  repo-relative AND as relative to each parent of the file's dir,
 *  same probe loop as Python. Multi-file packages: a Go directory IS
 *  a package, so we resolve `<modulePath>/foo/bar` to ANY .go file
 *  under `<repo>/foo/bar/`. We pick the alphabetically-first match
 *  to keep output deterministic. Pure — exported for tests. */
export function extractGoImportPaths(
  fileText: string,
  filePathRelToRepo: string,
  knownFiles: ReadonlySet<string>,
): string[] {
  const filePosix = toPosix(filePathRelToRepo);
  const fileDir = path.posix.dirname(filePosix);
  const out: string[] = [];
  const seen = new Set<string>();
  // Strip the full file text of single-line + block comments to avoid
  // matching `// import "foo"` as a real import. Cheap pass; doesn't
  // need to be perfect (a few false-positive matches are tolerable).
  const stripped = fileText
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  // Single import: `import "foo/bar"` or `import alias "foo/bar"`
  const singleRe = /^[\s]*import\s+(?:[a-zA-Z_][\w]*\s+)?"([^"]+)"/gm;
  // Block import: `import ( ... )` where each line is `"foo/bar"` or `alias "foo/bar"`
  const blockRe = /^[\s]*import\s*\(([\s\S]*?)\)/gm;
  const blockLineRe = /(?:^|\n)\s*(?:[a-zA-Z_][\w]*\s+)?"([^"]+)"/g;
  // Build a map of dir → first .go file in that dir for resolution.
  const dirToFirstGoFile = new Map<string, string>();
  for (const f of knownFiles) {
    if (path.posix.extname(f) !== ".go") continue;
    const d = path.posix.dirname(f);
    const cur = dirToFirstGoFile.get(d);
    if (!cur || f < cur) dirToFirstGoFile.set(d, f);
  }
  // Helper: try to resolve a Go import path. Returns the FIRST .go
  // file in the candidate dir, or null. We probe the path as repo-
  // relative AND as each suffix of the file's parent chain.
  const tryResolveGo = (importPath: string): string | null => {
    if (importPath.length === 0) return null;
    const candidates: string[] = [importPath];
    let cur = fileDir;
    while (cur !== "" && cur !== ".") {
      candidates.push(path.posix.join(cur, importPath));
      cur = path.posix.dirname(cur);
    }
    // Module-prefix-stripping heuristic: for `github.com/owner/repo/foo/bar`,
    // try the path with successive leading-segment trims (skip 1, 2, 3
    // segments). Common Go module prefixes have 2-3 leading segments.
    const segments = importPath.split("/");
    if (segments.length >= 3) {
      for (let trim = 1; trim <= 3 && trim < segments.length; trim++) {
        const sub = segments.slice(trim).join("/");
        candidates.push(sub);
        let cur2 = fileDir;
        while (cur2 !== "" && cur2 !== ".") {
          candidates.push(path.posix.join(cur2, sub));
          cur2 = path.posix.dirname(cur2);
        }
      }
    }
    for (const c of candidates) {
      const f = dirToFirstGoFile.get(c);
      if (f) return f;
    }
    return null;
  };
  const consider = (resolved: string | null) => {
    if (!resolved) return;
    if (resolved === filePosix) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };
  // Single-line imports
  for (const m of stripped.matchAll(singleRe)) {
    consider(tryResolveGo(m[1]!));
  }
  // Block imports
  for (const m of stripped.matchAll(blockRe)) {
    const block = m[1]!;
    for (const lm of block.matchAll(blockLineRe)) {
      consider(tryResolveGo(lm[1]!));
    }
  }
  return out;
}

/** Walk repo files + build forward-import graph. Best-effort: any
 *  per-file read failure is swallowed (file gets an empty edge set).
 *  Non-TS/JS files included with empty edges so the caller can use
 *  the graph as a "is this file in scope?" set. */
export async function buildImportGraph(
  clonePath: string,
  files: readonly string[],
): Promise<ImportGraph> {
  const graph: ImportGraph = new Map();
  const knownFiles = new Set(files.map(toPosix));
  for (const file of files) {
    const filePosix = toPosix(file);
    const ext = path.posix.extname(filePosix);
    // Dispatch by extension. T197/T199/T-Item-Lang: TS/JS, Python,
    // Rust, Go each have their own extractor. Other languages get
    // empty edges silently (caller treats them as in-scope but not
    // import-linked).
    const isTsJs = TS_JS_EXTS.has(ext);
    const isPython = PYTHON_EXTS.has(ext);
    const isRust = RUST_EXTS.has(ext);
    const isGo = GO_EXTS.has(ext);
    if (!isTsJs && !isPython && !isRust && !isGo) {
      graph.set(filePosix, new Set());
      continue;
    }
    let text: string;
    try {
      text = await fs.readFile(path.join(clonePath, file), "utf8");
    } catch {
      graph.set(filePosix, new Set());
      continue;
    }
    let edges: string[];
    if (isPython) edges = extractPythonImportPaths(text, filePosix, knownFiles);
    else if (isRust) edges = extractRustImportPaths(text, filePosix, knownFiles);
    else if (isGo) edges = extractGoImportPaths(text, filePosix, knownFiles);
    else edges = extractImportPaths(text, filePosix, knownFiles);
    graph.set(filePosix, new Set(edges));
  }
  return graph;
}

/** Group files into K clusters by import cohesion. Strongly-connected
 *  components first (files that import each other). Then BFS-greedy
 *  fill — an unassigned file joins the cluster it has the most edges
 *  into. Falls back to round-robin assignment for files with NO edges
 *  (typical for top-level config / docs). Pure — exported for tests.
 *
 *  This is a simple cohesion heuristic, not a true graph-partitioning
 *  algorithm. For most repos it produces reasonable clusters; pathological
 *  graphs (one giant SCC) collapse to a single mapper holding everything,
 *  which the runner must handle gracefully (caller falls back to
 *  round-robin slicing when this returns lopsided clusters). */
export function clusterByImports(
  files: readonly string[],
  graph: ImportGraph,
  k: number,
): string[][] {
  if (k <= 0) return [];
  if (files.length === 0) return Array.from({ length: k }, () => []);
  const filesPosix = files.map(toPosix);
  const buckets: string[][] = Array.from({ length: k }, () => []);
  // Step 1: find connected components in the bidirectional graph.
  // Each component is a unit — files in the same component all go in
  // the same bucket. This guarantees cohesion (a→b→c never splits)
  // even when the component is larger than the per-bucket target.
  const bidir = buildBidirectionalGraph(graph);
  const components = findConnectedComponents(filesPosix, bidir);
  // Sort components largest-first so big ones grab buckets early.
  components.sort((a, b) => b.length - a.length);
  // Step 2: greedy bin-pack — each component goes to whichever
  // bucket currently has the FEWEST files. Ties broken by lower
  // bucket index for stability.
  const sizes = new Array<number>(k).fill(0);
  for (const comp of components) {
    let smallest = 0;
    for (let i = 1; i < k; i++) {
      if (sizes[i]! < sizes[smallest]!) smallest = i;
    }
    buckets[smallest]!.push(...comp);
    sizes[smallest]! += comp.length;
  }
  return buckets;
}

/** Find connected components in an undirected adjacency map. Files
 *  with no neighbors are returned as singleton components. Pure —
 *  exported for tests. */
export function findConnectedComponents(
  files: readonly string[],
  bidir: Map<string, Set<string>>,
): string[][] {
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const seed of files) {
    if (seen.has(seed)) continue;
    const comp: string[] = [];
    const queue: string[] = [seed];
    while (queue.length > 0) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      comp.push(f);
      const neighbors = bidir.get(f);
      if (neighbors) {
        for (const n of neighbors) {
          if (!seen.has(n)) queue.push(n);
        }
      }
    }
    components.push(comp);
  }
  return components;
}

/** Bidirectional view of the import graph — for each file, the union
 *  of files it imports + files that import it. Used by clusterByImports
 *  for cohesion scoring + by stigmergy for cross-cluster pheromone
 *  spreading. Pure. */
export function buildBidirectionalGraph(graph: ImportGraph): Map<string, Set<string>> {
  const bidir = new Map<string, Set<string>>();
  for (const [from, edges] of graph) {
    if (!bidir.has(from)) bidir.set(from, new Set());
    for (const to of edges) {
      bidir.get(from)!.add(to);
      if (!bidir.has(to)) bidir.set(to, new Set());
      bidir.get(to)!.add(from);
    }
  }
  return bidir;
}

/** Find files related to the given file via the import graph (1-hop
 *  importers + importees). Used by stigmergy cross-cluster discovery
 *  to spread pheromones along code structure. Returns up to `cap`
 *  related files; empty when the seed has no edges. */
export function relatedFilesViaImports(
  seedFile: string,
  graph: ImportGraph,
  cap: number = 10,
): string[] {
  const bidir = buildBidirectionalGraph(graph);
  const related = bidir.get(toPosix(seedFile));
  if (!related) return [];
  return Array.from(related).slice(0, cap);
}
