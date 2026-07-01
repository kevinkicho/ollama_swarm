import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import { config } from "../config.js";
import {
  detectProvider,
  stripProviderPrefix,
  type Provider,
} from "@ollama-swarm/shared/providers";

export interface CloneOptions {
  url: string;
  destPath: string;
  force?: boolean;
}

export interface CloneResult {
  destPath: string;
  alreadyPresent: boolean;
  // Unit 47: prior-state stats so the UI can render a "you're resuming
  // an existing clone" banner without a separate round-trip. Always
  // populated; on a fresh clone the values reflect the shallow clone's
  // initial state (commits=1, changedFiles=0, untrackedFiles=0).
  // Best-effort — git failures yield zeros, never throw out of clone().
  priorCommits: number;
  priorChangedFiles: number;
  priorUntrackedFiles: number;
}

// Unit 47: prior-state stats helper. Used by clone() to populate the
// extended CloneResult. Exported so future tooling (resume detector,
// per-run gating) can reuse the same shape.
export interface CloneStats {
  commits: number;
  changedFiles: number;
  untrackedFiles: number;
}

// Given an http(s) git URL and a parent folder, return the absolute path the
// repo will be cloned to: `parentPath / <last-segment-minus-.git>`. The route
// handler uses this so the user provides a parent (e.g. C:\...\runs) and the
// server picks the subfolder name from the URL. Pure: no I/O.
export function deriveCloneDir(repoUrl: string, parentPath: string): string {
  let u: URL;
  try {
    u = new URL(repoUrl);
  } catch {
    throw new Error(`invalid repo URL: ${repoUrl}`);
  }
  const segments = u.pathname.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (!last) {
    throw new Error(`cannot derive repo name from URL: ${repoUrl}`);
  }
  const name = last.replace(/\.git$/i, "");
  if (!name) {
    throw new Error(`cannot derive repo name from URL: ${repoUrl}`);
  }
  return path.resolve(parentPath, name);
}

// Grounding Unit 6a: directories that listRepoFiles always skips. These are
// build artifacts, vendored deps, VCS internals, and caches — things the
// planner should never propose touching. Kept as a Set for O(1) lookup in
// the BFS inner loop.
export const LIST_REPO_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  ".next",
  ".turbo",
  ".nuxt",
  ".parcel-cache",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  "target", // rust/java
  "vendor", // php/go
  // Swarm run artifacts — not source code, pollute the file list
  ".swarm-data",
  ".swarm-monitor-logs",
  ".opencode",
  ".opencode_swarm",
]);

const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj",
  ".class", ".jar", ".war", ".ear",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".ogg", ".flac", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".psd", ".ai", ".sketch", ".fig",
  ".db", ".sqlite", ".sqlite3",
  ".bin", ".dat", ".pyc",
]);

export function isLikelyBinaryPath(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// Swarm-generated artifacts that are not source code. These pollute the
// file list and crowd out real source files when maxFiles is capped.
function isArtifactDir(dirName: string): boolean {
  // Digits_8 + timestamp_smoke pattern (e.g., 20260506_144420_smoke)
  if (/^\d{8}_\d{6}_smoke$/.test(dirName)) return true;
  return false;
}

function isArtifactFile(fileName: string): boolean {
  if (fileName.startsWith("deliverable-") && fileName.endsWith(".md")) return true;
  if (fileName.startsWith("summary-") && fileName.endsWith(".json")) return true;
  if (fileName.startsWith("next-actions-") && fileName.endsWith(".json")) return true;
  if (fileName === "summary.json") return true;
  if (fileName === "blackboard-state.json") return true;
  return false;
}

export class RepoService {
  async clone(opts: CloneOptions): Promise<CloneResult> {
    const abs = path.resolve(opts.destPath);
    const exists = await this.dirExists(abs);

    if (exists) {
      const entries = await fs.readdir(abs);
      const nonEmpty = entries.filter((e) => e !== ".").length > 0;
      if (nonEmpty) {
        const isRepo = await this.dirExists(path.join(abs, ".git"));
        if (isRepo && !opts.force) {
          const stats = await this.cloneStats(abs);
          return { destPath: abs, alreadyPresent: true, priorCommits: stats.commits, priorChangedFiles: stats.changedFiles, priorUntrackedFiles: stats.untrackedFiles };
        }
        // Local folder (not a git repo, not an HTTP URL) — use directly.
        const isLocalPath = !opts.url.startsWith("http://") && !opts.url.startsWith("https://");
        if (isLocalPath) {
          return { destPath: abs, alreadyPresent: true, priorCommits: 0, priorChangedFiles: 0, priorUntrackedFiles: 0 };
        }
        if (!opts.force) {
          throw new Error(
            `Destination ${abs} is not empty and is not a git repo. Pass force=true or pick another path.`,
          );
        }
      }
    } else {
      await fs.mkdir(abs, { recursive: true });
    }

    const authedUrl = this.withAuth(opts.url);
    const git = simpleGit();
    await git.clone(authedUrl, abs, ["--depth", "1"]);
    const stats = await this.cloneStats(abs);
    return {
      destPath: abs,
      alreadyPresent: false,
      priorCommits: stats.commits,
      priorChangedFiles: stats.changedFiles,
      priorUntrackedFiles: stats.untrackedFiles,
    };
  }

  // T-Item-1 (2026-05-04): clone the same URL into a per-attempt
  // subdir for parallel-clone-to-K-subdirs baseline. Picks a path
  // like `<parent>/<baseName>-attempt-<idx>` and clones into it via
  // the existing clone() guts (same GITHUB_TOKEN injection / force
  // handling). If the subdir already exists, deletes it first so we
  // start clean (idempotent across runs).
  async cloneToSubdir(input: {
    parent: string;
    baseName: string;
    attemptIdx: number;
    url: string;
  }): Promise<{ destPath: string }> {
    const destPath = path.join(
      input.parent,
      `${input.baseName}-attempt-${input.attemptIdx}`,
    );
    // Remove any stale subdir from a prior K-attempt run so we start
    // clean. Force flag in clone() doesn't cover the "directory has a
    // partial clone from a crashed prior run" case.
    try {
      await fs.rm(destPath, { recursive: true, force: true });
    } catch {
      // Best-effort — if we can't rm (file lock?) clone() will surface
      // a meaningful error.
    }
    const result = await this.clone({ url: input.url, destPath });
    return { destPath: result.destPath };
  }

  // Unit 47: count commits + working-tree changes inside an existing
  // clone. Used by clone() so its CloneResult tells the runner (and
  // ultimately the UI) whether this is a fresh shallow clone or a
  // resume on top of accumulated work.
  //
  // Best-effort: any git failure yields zeros rather than throwing —
  // we'd rather start the run with a missing banner than abort
  // because `git status` was momentarily unhappy.
  async cloneStats(clonePath: string): Promise<CloneStats> {
    try {
      const git = simpleGit(clonePath);
      // rev-list --count counts reachable commits from HEAD. On a
      // shallow `--depth 1` clone this returns 1; on a clone with
      // history it returns N.
      const commitsRaw = await git.raw(["rev-list", "--count", "HEAD"]);
      const commits = Number.parseInt(commitsRaw.trim(), 10) || 0;
      // status returns parsed porcelain. Modified+staged count vs
      // untracked split — matches what `git status -s` shows.
      const status = await git.status();
      // Modified | added | deleted | renamed all count as "changed";
      // not_added is the porcelain "??" untracked bucket.
      const changedFiles =
        status.modified.length +
        status.created.length +
        status.deleted.length +
        status.renamed.length;
      const untrackedFiles = status.not_added.length;
      return { commits, changedFiles, untrackedFiles };
    } catch {
      return { commits: 0, changedFiles: 0, untrackedFiles: 0 };
    }
  }

  // Unit 48: append runner-written file patterns to the clone's
  // local .git/info/exclude so they don't show up in `git status` as
  // untracked. Specifically NOT touching the user's .gitignore —
  // .git/info/exclude lives inside .git/ so it's never checked in or
  // pushed, doesn't surface as "M .gitignore" in the user's working
  // tree, and survives garbage collection.
  //
  // Idempotent: re-runs append nothing if every entry is already
  // present. Best-effort I/O — a failure here just means git status
  // still shows our artifacts; not a run-breaking error.
  //
  // Patterns excluded:
  //   opencode.json        — per-clone agent config (Unit 42)
  //   blackboard-state.json — runtime snapshot (BlackboardRunner only)
  //   summary.json          — final run summary
  //   summary-*.json        — Unit 49's per-run summary file naming
  async excludeRunnerArtifacts(clonePath: string): Promise<void> {
    const gitDir = path.join(clonePath, ".git");
    // Guard: only operate inside an existing .git directory. If the
    // caller passed a non-repo path (clone failed, wrong destPath),
    // silently no-op rather than fabricating a stray .git/ tree.
    if (!(await this.dirExists(gitDir))) return;
    const excludePath = path.join(gitDir, "info", "exclude");
    const STANDARD_ENTRIES = [
      "# ollama_swarm runner artifacts (Unit 48)",
      "opencode.json",
      "blackboard-state.json",
      "summary.json",
      "summary-*.json",
      "# Direction 1 + 6: outcome history + checkpoints",
      ".swarm-data/",
      ".swarm-checkpoints/",
    ];
    let existing = "";
    try {
      existing = await fs.readFile(excludePath, "utf8");
    } catch {
      // .git/info/exclude doesn't exist yet — create the info/ dir
      // (under the verified-existing .git/) so the appendFile below
      // has somewhere to land. Some shallow clones omit the file;
      // git itself recreates it on demand.
      try {
        await fs.mkdir(path.dirname(excludePath), { recursive: true });
      } catch {
        // info/ dir is unwriteable for some reason; best-effort bail.
        return;
      }
    }
    // Existing entries normalized for comparison: trim and skip blank
    // lines. Keeps the helper idempotent across whitespace drift.
    const existingLines = new Set(
      existing
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );
    const toAdd = STANDARD_ENTRIES.filter((e) => !existingLines.has(e.trim()));
    if (toAdd.length === 0) return;
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const append = `${sep}${toAdd.join("\n")}\n`;
    try {
      await fs.appendFile(excludePath, append, "utf8");
    } catch {
      // best-effort
    }
  }

  // E3 Phase 5 (2026-04-29): writeOpencodeConfig DELETED. Prompts now
  // route through SessionProvider directly; opencode.json is no longer
  // generated. The detectProvider/stripProviderPrefix imports above are
  // also dead but kept until the next round of import cleanup.

  async readReadme(clonePath: string): Promise<string | null> {
    const candidates = ["README.md", "README", "README.rst", "readme.md"];
    for (const name of candidates) {
      try {
        const txt = await fs.readFile(path.join(clonePath, name), "utf8");
        return txt;
      } catch {
        // try next
      }
    }
    return null;
  }

  // Phase 9: used by the run summary. Returns `git status --porcelain`
  // output and an entry count. Swallows errors (a malformed clone still
  // needs a summary) and returns an empty status in that case.
  async gitStatus(clonePath: string): Promise<{ porcelain: string; changedFiles: number }> {
    try {
      const git = simpleGit(clonePath);
      const out = await git.raw(["status", "--porcelain"]);
      const lines = out.split(/\r?\n/).filter((l) => l.length > 0);
      return { porcelain: out, changedFiles: lines.length };
    } catch {
      return { porcelain: "", changedFiles: 0 };
    }
  }

  // #237 (2026-04-28): commit ALL working-tree changes (staged +
  // untracked) with the given message. Used by the build-style TODO
  // executor where bash side effects ARE the work — runner needs to
  // commit whatever changed without per-file CAS.
  async commitAll(clonePath: string, message: string): Promise<void> {
    const git = simpleGit(clonePath);
    await git.add(["-A"]);
    await git.commit(message);
  }

  async listTopLevel(clonePath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(clonePath, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith(".git"))
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name));
    } catch {
      return [];
    }
  }

  // Grounding Unit 6a: breadth-first walk of the clone returning up to
  // maxFiles repo-relative FILE paths (not directories), with conventional
  // ignores applied. Used to seed the planner + first-pass-contract prompts
  // so their expectedFiles are grounded in real repo structure instead of
  // guessed from top-level-dirs-plus-README.
  //
  // Two-phase BFS: first explore all directories to build parent coverage,
  // then emit files. Pure BFS interleaves files with directory enqueues,
  // which is fine for small repos but fails in repos with many root-level
  // files (e.g., 149 deliverable-*.md files at root) — those fill the
  // maxFiles cap before any subdirectory is visited, causing ALL
  // expectedFiles paths to be classified "suspicious" (parent dir not in
  // list). By dequeuing directories first (phase 1) we guarantee that
  // meaningful source trees (server/src/, lib/, .swarm-design/) appear
  // before we fill slots with root artifacts.
  async listRepoFiles(
    clonePath: string,
    opts: { maxFiles?: number } = {},
  ): Promise<string[]> {
    const maxFiles = opts.maxFiles ?? 300;
    const out: string[] = [];

    // Phase 1: BFS-expand directories, collecting files per-level.
    // We process all directories at each depth before emitting any files,
    // so parent directories are always represented in the output before
    // deep files that depend on them for grounding.
    const dirQueue: string[] = [""];
    const filesByDir = new Map<string, string[]>();

    while (dirQueue.length > 0) {
      const rel = dirQueue.shift()!;
      const abs = rel === "" ? clonePath : path.join(clonePath, rel);
      let entries: Dirent[];
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      const levelFiles: string[] = [];
      for (const entry of entries) {
        if (LIST_REPO_IGNORED_DIRS.has(entry.name)) continue;
        if (entry.isDirectory() && isArtifactDir(entry.name)) continue;
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          dirQueue.push(childRel);
        } else if (entry.isFile()) {
          if (isLikelyBinaryPath(entry.name)) continue;
          if (isArtifactFile(entry.name)) continue;
          levelFiles.push(childRel);
        }
      }
      if (levelFiles.length > 0) {
        filesByDir.set(rel, levelFiles);
      }
    }

    // Phase 2: Emit files directory by directory (BFS order), respecting cap.
    // Root files come first (backward compat), but now we're guaranteed
    // that subdirectories have already been discovered so their contents
    // will follow. The Map preserves insertion order which is BFS order
    // since dirQueue processes directories breadth-first.
    for (const [, files] of filesByDir) {
      for (const f of files) {
        if (out.length >= maxFiles) break;
        out.push(f);
      }
      if (out.length >= maxFiles) break;
    }

    return out;
  }

  async dirExists(p: string): Promise<boolean> {
    try {
      const s = await fs.stat(p);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  private withAuth(url: string): string {
    if (!config.GITHUB_TOKEN) return url;
    try {
      const u = new URL(url);
      if (u.hostname === "github.com" && !u.username) {
        u.username = config.GITHUB_TOKEN;
      }
      return u.toString();
    } catch {
      return url;
    }
  }
}
