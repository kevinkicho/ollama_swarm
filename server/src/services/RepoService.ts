import fs from "node:fs/promises";
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
          return { destPath: abs, alreadyPresent: true };
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
    return { destPath: abs, alreadyPresent: false };
  }

  async writeOpencodeConfig(clonePath: string, model: string): Promise<void> {
    const filePath = path.join(clonePath, "opencode.json");
    const payload = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        ollama: {
          npm: "@ai-sdk/openai-compatible",
          name: "Ollama (local)",
          options: { baseURL: config.OLLAMA_BASE_URL },
          models: {
            [model]: { name: model },
          },
        },
      },
      // Custom agent we ask every session to run as. Tools + filesystem
      // permissions are all locked off so glm-5.1:cloud can't sneak real file
      // edits through opencode's built-in tool loop — the Phase 4 dry-run
      // broke because the default agent had `edit` enabled and the model used
      // it instead of returning JSON diffs. We pass `agent: "swarm"` on every
      // session.prompt call (see BlackboardRunner.promptAgent).
      agent: {
        swarm: {
          mode: "primary" as const,
          description: "Pure text-in/text-out agent for the ollama_swarm orchestrator. No filesystem or shell access.",
          tools: {
            read: false,
            write: false,
            edit: false,
            multiedit: false,
            patch: false,
            bash: false,
            grep: false,
            glob: false,
            list: false,
            webfetch: false,
            task: false,
            todoread: false,
            todowrite: false,
          },
          permission: {
            edit: "deny" as const,
            bash: "deny" as const,
            webfetch: "deny" as const,
          },
        },
      },
    };
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

  private async dirExists(p: string): Promise<boolean> {
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
