import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import { config } from "../config.js";

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

  async writeOpencodeConfig(clonePath: string, model: string | readonly string[]): Promise<void> {
    const filePath = path.join(clonePath, "opencode.json");
    // Unit 42: accept multiple models so per-agent overrides
    // (planner vs worker) can each resolve at session-create time.
    // Single-string callers stay correct — wrapped + de-duped.
    const modelList = (typeof model === "string" ? [model] : [...model])
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    const uniqueModels = Array.from(new Set(modelList));
    if (uniqueModels.length === 0) {
      throw new Error("writeOpencodeConfig: at least one model required");
    }
    const modelsBlock: Record<string, { name: string }> = {};
    for (const m of uniqueModels) modelsBlock[m] = { name: m };
    const payload = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        ollama: {
          npm: "@ai-sdk/openai-compatible",
          name: "Ollama (local)",
          options: { baseURL: config.OLLAMA_BASE_URL },
          models: modelsBlock,
        },
      },
      // Two agent profiles:
      //
      // - `swarm` — used by BlackboardRunner workers. Tools + filesystem
      //   permissions ALL locked off so glm-5.1:cloud can't sneak real
      //   file edits through opencode's built-in tool loop (Phase 4
      //   dry-run broke because the default agent had `edit` enabled
      //   and the model used it instead of returning JSON diffs).
      //   Workers must return their changes as structured JSON; the
      //   runner writes them after CAS check.
      //
      // - `swarm-read` — Unit 20: used by discussion-only presets
      //   (round-robin, role-diff, council, debate-judge,
      //   orchestrator-worker, map-reduce, stigmergy). These agents'
      //   prompts already tell them to use file-read / grep / find-files
      //   to inspect the repo; before Unit 20 those instructions were
      //   a lie because the prompts ran under `swarm` (no tools).
      //   `swarm-read` enables READ-only tools (read / grep / glob /
      //   list) so agents can actually inspect the code, while keeping
      //   write / edit / bash hard-denied so they can't accidentally
      //   modify the clone — discussion-only stays discussion-only by
      //   enforcement, not by hope.
      // #234 (2026-04-27 evening): migrated from deprecated v1 `tools`
      // field to v2 `permission` ruleset. v2 Agent type has no `tools`
      // field at all (per node_modules/@opencode-ai/sdk/dist/v2/gen/
      // types.gen.d.ts:1804). Permissions are the unified replacement.
      // Simple-object form (`{ "*": "deny", "read": "allow" }`) is
      // documented at opencode.ai/docs/permissions; last matching rule
      // wins, so place catch-all `*` first then specific overrides.
      agent: {
        swarm: {
          mode: "primary" as const,
          description: "Pure text-in/text-out agent for the ollama_swarm blackboard worker. No filesystem or shell access.",
          permission: {
            "*": "deny" as const,
          },
        },
        "swarm-read": {
          mode: "primary" as const,
          description: "Read-only inspection agent for the ollama_swarm discussion presets. Read / grep / glob enabled; edit / write / bash hard-denied.",
          permission: {
            "*": "deny" as const,
            read: "allow" as const,
            grep: "allow" as const,
            glob: "allow" as const,
          },
        },
        // #235 (2026-04-27 evening): orchestrator profile — same read
        // perms as swarm-read PLUS the `task` tool so this agent can
        // dispatch SubtaskPartInput parts. Used by the parent prompt
        // in council/orchestrator-worker/mapreduce/etc patterns. Child
        // subtasks run as their own (still-restricted) agent profile.
        "swarm-orchestrator": {
          mode: "primary" as const,
          description: "Orchestrator profile that dispatches subtasks to other swarm agents. Inherits swarm-read filesystem perms + grants the `task` tool for SubtaskPartInput dispatch.",
          permission: {
            "*": "deny" as const,
            read: "allow" as const,
            grep: "allow" as const,
            glob: "allow" as const,
            task: "allow" as const,
          },
        },
      },
    };

    // Unit 26: Playwright MCP integration — adds a `mcp.playwright`
    // server entry + a `swarm-ui` agent profile that can drive a
    // headless browser via the official @playwright/mcp package.
    // OFF by default; users who want UI inspection agents opt in via
    // `MCP_PLAYWRIGHT_ENABLED=true` in .env AND `npm install -g
    // @playwright/mcp && npx playwright install` on their box.
    // When disabled, opencode.json shape is bit-for-bit identical to
    // pre-Unit-26 output so existing runs are unaffected.
    if (config.MCP_PLAYWRIGHT_ENABLED) {
      (payload as Record<string, unknown>).mcp = {
        playwright: {
          type: "local",
          command: ["npx", "@playwright/mcp@latest", "--headless", "--isolated"],
        },
      };
      (payload.agent as Record<string, unknown>)["swarm-ui"] = {
        mode: "primary" as const,
        description:
          "UI-inspection agent with Playwright MCP browser access. Read-only filesystem; can navigate, snapshot, screenshot, and interact with the target app's live UI for verification of user-facing criteria.",
        // #234: v2 permission ruleset replaces the deprecated v1 tools field.
        // MCP tools (the playwright_* family) flow through opencode's MCP
        // bridge — granted via the `mcp` field below, not via permission rules.
        permission: {
          "*": "deny" as const,
          read: "allow" as const,
          grep: "allow" as const,
          glob: "allow" as const,
        },
        mcp: {
          // Enable all tools exposed by the playwright MCP server
          // (navigate / snapshot / click / type / take_screenshot /
          // evaluate / wait_for / press_key etc.). OpenCode exposes
          // them to the agent with `playwright_*` prefixes.
          playwright: true,
        },
      };
    }

    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  }

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
