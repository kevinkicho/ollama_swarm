// T197 (2026-05-04): import-graph extraction helper.
//
// FIRST-CUT IMPLEMENTATION — TypeScript/JavaScript only, regex-based.
// Real production use should swap in ts-morph or babel for full
// AST coverage; this is the "good enough for slicing + pheromone
// spreading" version that ships in 1 file with no new deps.
//
// Two consumers:
//   1. map-reduce smart slicing (T197 — MapReduceRunner.sliceByImportGraph)
//      groups files that import each other into the same mapper slice
//   2. stigmergy cross-cluster discovery (T197 — StigmergyRunner)
//      when an explorer surfaces a finding, plants pheromones on
//      related files (importers + importees)
//
// EXPLICIT GAPS — call them out in PRs that touch this file:
//   - Python/Rust/Go imports: skipped silently. Returns empty edges
//     for non-TS/JS files. Real cross-language support is days of work.
//   - Dynamic imports `import("./x")` are detected but not resolved
//     when the path is a runtime expression.
//   - Re-exports `export { x } from "./y"` are detected.
//   - Bare specifiers `from "lodash"` are skipped (we only care about
//     intra-repo edges).
//   - Path aliases (`@/foo` from tsconfig.json) are skipped — caller
//     would need to inject the alias map.
//   - Import errors (file unreadable, encoding issue) are swallowed;
//     missing edges treated as "no relationship."

import { promises as fs } from "node:fs";
import path from "node:path";

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

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
    if (!TS_JS_EXTS.has(ext)) {
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
    const edges = extractImportPaths(text, filePosix, knownFiles);
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
