import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import { config } from "../config.js";
import {
  detectProvider,
  stripProviderPrefix,
  type Provider,
} from "../../../shared/src/providers.js";

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
          // Unit 47: populate prior-state stats so the runner can emit
          // a "you're resuming an existing clone" signal to the UI.
          const stats = await this.cloneStats(abs);
          return {
            destPath: abs,
            alreadyPresent: true,
            priorCommits: stats.commits,
            priorChangedFiles: stats.changedFiles,
            priorUntrackedFiles: stats.untrackedFiles,
          };
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
  // BFS on purpose: shallow files (README.md, package.json, src/index.ts)
  // surface before deep files (src/a/b/c/helper.ts). That matches what a
  // human glancing at a repo would see first, which is what the planner
  // should weight heaviest.
  //
  // Paths are normalized to forward slashes for prompt consistency — the
  // LLM shouldn't care about Windows backslashes.
  async listRepoFiles(
    clonePath: string,
    opts: { maxFiles?: number } = {},
  ): Promise<string[]> {
    const maxFiles = opts.maxFiles ?? 150;
    const out: string[] = [];
    const queue: string[] = [""];

    while (queue.length > 0 && out.length < maxFiles) {
      const rel = queue.shift()!;
      const abs = rel === "" ? clonePath : path.join(clonePath, rel);
      let entries: Dirent[];
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (out.length >= maxFiles) break;
        if (LIST_REPO_IGNORED_DIRS.has(entry.name)) continue;
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          queue.push(childRel);
        } else if (entry.isFile()) {
          if (isLikelyBinaryPath(entry.name)) continue;
          out.push(childRel);
        }
        // symlinks/sockets/etc. deliberately skipped
      }
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
