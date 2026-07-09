import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { StructureEdge, StructureLayer, StructureModule } from "./types.js";

export const MAX_STRUCTURE_FILES = 200;
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".swarm",
  "logs",
]);

const IMPORT_FROM_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function moduleKeyForFile(repoRelative: string): string {
  const norm = repoRelative.replace(/\\/g, "/");
  const parts = norm.split("/");
  if (parts.length <= 2) return parts[0] ?? norm;
  return `${parts[0]}/${parts[1]}`;
}

export function extractRelativeImports(content: string): string[] {
  const out = new Set<string>();
  for (const re of [IMPORT_FROM_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      if (spec?.startsWith(".")) out.add(spec);
    }
  }
  return [...out];
}

export function resolveRelativeImport(fromFile: string, spec: string): string | null {
  const base = path.posix.dirname(fromFile.replace(/\\/g, "/"));
  const joined = path.posix.normalize(path.posix.join(base, spec));
  if (joined.startsWith("..")) return null;
  return joined.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
}

async function walkCodeFiles(
  root: string,
  dir: string,
  out: string[],
  budget: { left: number },
): Promise<void> {
  if (budget.left <= 0) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (budget.left <= 0) break;
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walkCodeFiles(root, full, out, budget);
    } else if (CODE_EXT.has(path.extname(name).toLowerCase())) {
      out.push(full);
      budget.left--;
    }
  }
}

export async function buildStructureLayer(clonePath: string): Promise<StructureLayer | null> {
  const files: string[] = [];
  await walkCodeFiles(clonePath, clonePath, files, { left: MAX_STRUCTURE_FILES });
  if (files.length === 0) return null;

  const moduleCounts = new Map<string, number>();
  const edgeSet = new Set<string>();
  const fileModules = new Map<string, string>();

  for (const abs of files) {
    const rel = path.relative(clonePath, abs).replace(/\\/g, "/");
    const mod = moduleKeyForFile(rel);
    moduleCounts.set(mod, (moduleCounts.get(mod) ?? 0) + 1);
    fileModules.set(rel, mod);

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const fromMod = mod;
    for (const spec of extractRelativeImports(content)) {
      const resolved = resolveRelativeImport(rel, spec);
      if (!resolved) continue;
      const toMod = moduleKeyForFile(resolved);
      if (toMod === fromMod) continue;
      edgeSet.add(`${fromMod}→${toMod}`);
    }
  }

  const modules: StructureModule[] = [...moduleCounts.entries()]
    .map(([p, fileCount]) => ({ path: p, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, 40);

  const edges: StructureEdge[] = [...edgeSet].slice(0, 120).map((k) => {
    const [from, to] = k.split("→");
    return { from, to };
  });

  return {
    updatedAt: Date.now(),
    modules,
    edges,
    scannedFiles: files.length,
  };
}