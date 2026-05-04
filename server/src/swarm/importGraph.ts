// T197 (2026-05-04) + T199 multi-language extension (2026-05-04):
// import-graph extraction helper.
//
// Regex-based — ts-morph / tree-sitter would be more accurate but
// would add a heavy dep. The regex version covers the common cases
// for two languages today: TypeScript/JavaScript (T197) and Python
// (T199). Rust/Go still skipped silently — they'd benefit from a
// real AST parser.
//
// Two consumers:
//   1. map-reduce smart slicing — groups files that import each
//      other into the same mapper slice
//   2. stigmergy cross-cluster discovery — when an explorer surfaces
//      a finding, plants pheromones on related files
//
// EXPLICIT GAPS — call them out in PRs that touch this file:
//   - Rust/Go imports: skipped silently. Returns empty edges for
//     non-TS/JS/Python files.
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
    // T199: dispatch by extension. TS/JS gets the original
    // extractImportPaths; Python gets extractPythonImportPaths.
    // Other languages (Rust/Go) return empty edges silently.
    const isTsJs = TS_JS_EXTS.has(ext);
    const isPython = PYTHON_EXTS.has(ext);
    if (!isTsJs && !isPython) {
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
    const edges = isPython
      ? extractPythonImportPaths(text, filePosix, knownFiles)
      : extractImportPaths(text, filePosix, knownFiles);
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
