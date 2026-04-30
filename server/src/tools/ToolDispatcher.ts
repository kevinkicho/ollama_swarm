// E3 Phase 4 (skeleton): own the tool grants opencode handles today.
// Today this dispatcher isn't wired into the providers — that's Phase 4
// part 2 (provider tool_use protocols: OpenAI tool calls / Anthropic
// tool_use blocks / Ollama function calls). This commit ships the
// foundation: profile permission tables + handlers for read/grep/glob/
// list. Bash is deliberately omitted — needs a security review against
// the existing buildCommandAllowlist.ts before it can be exposed.
//
// Profiles mirror the rules in RepoService.writeOpencodeConfig today:
//   - swarm         deny everything (workers return JSON envelopes only)
//   - swarm-read    read / grep / glob / list ALLOWED, write / edit / bash denied
//   - swarm-builder bash + read-side ALLOWED, write / edit denied
//                   (intentionally NOT shipping bash today; profile defined for
//                    completeness so Phase 4 part 2 can light it up after the
//                    bash gate is reviewed)
//
// Path safety: every read-family tool resolves through resolveSafe so a
// hallucinated `..` or absolute path can't escape the clone.

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveSafe } from "../swarm/blackboard/resolveSafe.js";

export type ToolName = "read" | "grep" | "glob" | "list" | "bash" | "write" | "edit";
export type ProfileName = "swarm" | "swarm-read" | "swarm-builder";
export type Permission = "allow" | "deny";

export const PROFILES: Record<ProfileName, Record<ToolName, Permission>> = {
  swarm: {
    read: "deny",
    grep: "deny",
    glob: "deny",
    list: "deny",
    bash: "deny",
    write: "deny",
    edit: "deny",
  },
  "swarm-read": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "deny",
    write: "deny",
    edit: "deny",
  },
  "swarm-builder": {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    // bash declared as allow in the table for parity with opencode's
    // permission rules, but the dispatcher's bash() handler throws
    // "not yet implemented" until the security review lands.
    bash: "allow",
    write: "deny",
    edit: "deny",
  },
};

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Per-tool handlers.
// ---------------------------------------------------------------------------

async function readTool(clone: string, args: Record<string, unknown>): Promise<ToolResult> {
  const p = String(args.path ?? "");
  if (!p) return { ok: false, error: "read: missing `path` arg" };
  try {
    const abs = await resolveSafe(clone, p);
    const text = await fs.readFile(abs, "utf8");
    // Cap output at 200 KB so a misclick doesn't dump a giant file
    // into the model's context.
    const CAP = 200 * 1024;
    return { ok: true, output: text.length > CAP ? text.slice(0, CAP) + "\n…(truncated)" : text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function listTool(clone: string, args: Record<string, unknown>): Promise<ToolResult> {
  const p = String(args.path ?? ".");
  try {
    const abs = await resolveSafe(clone, p);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith(".git"))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { ok: true, output: lines.join("\n") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function globTool(clone: string, args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return { ok: false, error: "glob: missing `pattern` arg" };
  // Bounded recursive walk — same shape as RepoService.listRepoFiles.
  // Glob support: only `**/<filename>` and `<dir>/<filename>` patterns
  // for the skeleton. Full minimatch comes when a real consumer needs it.
  try {
    const matches: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      const abs = rel === "" ? clone : await resolveSafe(clone, rel);
      const entries = await fs.readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".git") || e.name === "node_modules") continue;
        const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(childRel);
        else if (matchesGlob(childRel, pattern)) matches.push(childRel);
        if (matches.length >= 500) return;
      }
    };
    await walk("");
    return { ok: true, output: matches.join("\n") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Cheap glob: supports `**/<basename>`, `<dir>/<basename>`, plain `<basename>`.
// Real minimatch would be a dep we don't need yet for the skeleton.
function matchesGlob(filePath: string, pattern: string): boolean {
  if (pattern.startsWith("**/")) {
    const tail = pattern.slice(3);
    return path.basename(filePath) === tail || filePath.endsWith(`/${tail}`);
  }
  return filePath === pattern || path.basename(filePath) === pattern;
}

async function grepTool(clone: string, args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return { ok: false, error: "grep: missing `pattern` arg" };
  const subdir = String(args.path ?? ".");
  try {
    const re = new RegExp(pattern);
    const root = await resolveSafe(clone, subdir);
    const hits: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".git") || e.name === "node_modules") continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) {
          try {
            const text = await fs.readFile(abs, "utf8");
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                const rel = path.relative(clone, abs).replace(/\\/g, "/");
                hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`);
                if (hits.length >= 200) return;
              }
            }
          } catch {
            // skip unreadable files (binary, etc.)
          }
        }
      }
    };
    await walk(root);
    return { ok: true, output: hits.join("\n") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Dispatcher.
// ---------------------------------------------------------------------------

export class ToolDispatcher {
  constructor(
    private readonly profile: ProfileName,
    private readonly clonePath: string,
  ) {}

  async dispatch(call: ToolCall): Promise<ToolResult> {
    const perm = PROFILES[this.profile][call.tool];
    if (perm !== "allow") {
      return {
        ok: false,
        error: `tool "${call.tool}" denied by profile "${this.profile}"`,
      };
    }
    switch (call.tool) {
      case "read":
        return readTool(this.clonePath, call.args);
      case "list":
        return listTool(this.clonePath, call.args);
      case "glob":
        return globTool(this.clonePath, call.args);
      case "grep":
        return grepTool(this.clonePath, call.args);
      case "bash":
        // Profile says allow but the handler refuses until the security
        // review lands. Mirror the rule shape so the eventual wiring
        // is just "delete this throw + import the bash handler."
        return {
          ok: false,
          error: "bash dispatch not yet implemented (Phase 4 part 2 — pending security review)",
        };
      case "write":
      case "edit":
        // No profile allows these today; if we ever change that, the
        // PROFILES table above is the single source of truth.
        return { ok: false, error: `${call.tool} dispatch not yet implemented` };
    }
  }
}
