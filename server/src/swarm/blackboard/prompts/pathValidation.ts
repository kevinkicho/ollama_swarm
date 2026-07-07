// Unit 6b: classify planner-emitted paths against the REPO FILE LIST the
// planner was seeded with.
//
// Three buckets:
//   - existing       — path appears verbatim in repoFiles (edit-an-existing-file)
//   - plausible-new  — path not in repoFiles, but parent directory IS in the
//                      list (or path is at repo root). The worker will create
//                      the file and writeFileAtomic handles missing parents.
//   - suspicious     — path not in repoFiles AND parent directory not in the
//                      list. Previously this was a hard rejection; now it's
//                      accepted with a warning — the planner may legitimately
//                      create new directory structures.
//
// Pure. No I/O. repoFiles is expected to use forward slashes (listRepoFiles's
// contract), but we defensively normalize inputs too — a model that emits
// `src\tests\foo.ts` shouldn't sneak past classification just because of
// slashes.

export type PathClassification = "existing" | "plausible-new" | "suspicious";

export interface PathRejection {
  path: string;
  reason: string;
}

export interface ClassificationResult {
  accepted: string[];
  rejected: PathRejection[];
}

export function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

export function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return "";
  return path.slice(0, idx);
}

export function classifyPath(path: string, repoFiles: readonly string[]): PathClassification {
  const norm = toForwardSlashes(path);
  if (repoFiles.includes(norm)) return "existing";
  const parent = parentDir(norm);
  // Root-level new file: any repo has a root, so parent "exists" by definition.
  if (parent === "") return "plausible-new";
  const parentPrefix = parent + "/";
  for (const f of repoFiles) {
    if (f.startsWith(parentPrefix)) return "plausible-new";
  }
  return "suspicious";
}

// Classify a batch. Strips suspicious entries into `rejected`, keeps
// existing + plausible-new in `accepted`. The caller decides what to do with
// rejections (post a finding, drop the enclosing todo, etc.).
export function classifyExpectedFiles(
  paths: string[],
  repoFiles: string[],
): ClassificationResult {
  const accepted: string[] = [];
  const rejected: PathRejection[] = [];
  for (const p of paths) {
    const verdict = classifyPath(p, repoFiles);
    if (verdict === "suspicious") {
      // Accept suspicious paths with a warning — the planner may
      // legitimately create new directory structures.
      accepted.push(p);
      rejected.push({ path: p, reason: `parent directory not in repo file list (${parentDir(toForwardSlashes(p))})` });
    } else {
      accepted.push(p);
    }
  }
  return { accepted, rejected };
}
