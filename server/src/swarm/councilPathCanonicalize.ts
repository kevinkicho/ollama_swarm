/** Normalize a repo-relative path for comparison. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

/**
 * Collapse duplicate path variants (e.g. `docs/foo.md` + `foo.md`) to a single
 * canonical path per basename. Prefers paths that exist in the repo; when both
 * exist, prefers the shorter (root-relative) path.
 */
export function canonicalizeExpectedFiles(
  paths: readonly string[],
  repoFiles: readonly string[],
): string[] {
  if (paths.length <= 1) return paths.map(normalizePath);

  const repoSet = new Set(repoFiles.map(normalizePath));
  const groups = new Map<string, string[]>();

  for (const raw of paths) {
    const p = normalizePath(raw);
    const base = basename(p);
    const list = groups.get(base) ?? [];
    list.push(p);
    groups.set(base, list);
  }

  const result: string[] = [];
  for (const variants of groups.values()) {
    if (variants.length === 1) {
      result.push(variants[0]!);
      continue;
    }
    const inRepo = variants.filter((v) => repoSet.has(v));
    const candidates = inRepo.length > 0 ? inRepo : variants;
    candidates.sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    );
    result.push(candidates[0]!);
  }
  return result;
}