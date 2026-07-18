/**
 * Native tool handlers (read/grep/glob/list/bash/propose_hunks).
 * Extracted from ToolDispatcher for LOC hygiene.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveSafe } from "../swarm/blackboard/resolveSafe.js";
import { checkBuildCommand } from "../swarm/blackboard/buildCommandAllowlist.js";
import { applyHunks, type Hunk } from "../swarm/blackboard/applyHunks.js";
import type { ToolResult } from "./toolDispatchTypes.js";

export const BASH_TIMEOUT_MS = 60_000;
/** Auto-approve / high-trust runs get a longer bash wall for proprietary scripts. */
export const BASH_TIMEOUT_AUTO_MS = 300_000;
export const BASH_OUTPUT_CAP = 200 * 1024;

const HUNK_OPS = new Set([
  "replace",
  "create",
  "append",
  "delete",
  "write",
  "replace_between",
]);

function coerceHunksFromArgs(args: Record<string, unknown>): Hunk[] | { error: string } {
  let raw: unknown = args.hunks;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: "propose_hunks: `hunks` must be a JSON array (or JSON string of an array)" };
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      error:
        'propose_hunks: pass hunks:[{op,file,...}] — e.g. replace_between/write/replace. Dry-run by default; set apply:true to write files.',
    };
  }
  const out: Hunk[] = [];
  for (let i = 0; i < raw.length; i++) {
    const h = raw[i];
    if (!h || typeof h !== "object" || Array.isArray(h)) {
      return { error: `propose_hunks: hunks[${i}] must be an object` };
    }
    const o = h as Record<string, unknown>;
    const op = String(o.op ?? "");
    const file = String(o.file ?? "").trim();
    if (!HUNK_OPS.has(op) || !file) {
      return { error: `propose_hunks: hunks[${i}] needs op (${[...HUNK_OPS].join("|")}) and file` };
    }
    out.push(o as unknown as Hunk);
  }
  return out;
}

function excerptAround(text: string, needle: string, radius = 180): string {
  const idx = text.indexOf(needle);
  if (idx < 0) {
    return text.slice(0, Math.min(text.length, radius * 2));
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/**
 * Dry-run (default) or apply (apply:true) hunks against the live clone.
 * Returns structured feedback so workers can fix anchors mid-turn without
 * guessing a giant exact search string for windowed files.
 */
export async function proposeHunksTool(
  clonePath: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const coerced = coerceHunksFromArgs(args);
  if ("error" in coerced) return { ok: false, error: coerced.error };
  const hunks = coerced;
  const apply = args.apply === true || args.apply === "true";

  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file)!.push(h);
  }

  const currentTexts: Record<string, string | null> = {};
  for (const file of byFile.keys()) {
    try {
      const abs = await resolveSafe(clonePath, file);
      currentTexts[file] = await fs.readFile(abs, "utf8");
    } catch {
      currentTexts[file] = null;
    }
  }

  const applied = applyHunks(currentTexts, hunks);
  if (!applied.ok) {
    // Attach nearby content for the first file that might help re-anchor.
    // Prefer structured ApplyMissReport (kind, needle, uniqueCandidates) when
    // applyHunks produced one; keep `nearby` for older consumers.
    const feedback: Record<string, string> = {};
    for (const [file, text] of Object.entries(currentTexts)) {
      if (text == null) continue;
      const fileHunks = byFile.get(file) ?? [];
      for (const h of fileHunks) {
        if (h.op === "replace" && "search" in h) {
          feedback[file] = excerptAround(text, h.search.slice(0, 40));
          break;
        }
        if (h.op === "replace_between" && "start" in h) {
          feedback[file] = excerptAround(text, h.start.slice(0, 80));
          break;
        }
      }
      if (!feedback[file] && text.length > 0) {
        feedback[file] = text.slice(0, 400) + (text.length > 400 ? "…" : "");
      }
    }
    return {
      ok: false,
      error: JSON.stringify({
        ok: false,
        reason: applied.error,
        apply,
        miss: applied.miss ?? null,
        nearby: feedback,
        tip:
          "Use replace_between with unique start/endExclusive headings, or write for full-file rewrite. Grep for the exact heading first. Re-ground on miss.nearbyExcerpt / miss.uniqueCandidates when present.",
      }),
    };
  }

  const previews: Record<string, { beforeLen: number; afterLen: number; head: string }> = {};
  for (const [file, newText] of Object.entries(applied.newTextsByFile)) {
    const before = currentTexts[file];
    previews[file] = {
      beforeLen: before?.length ?? 0,
      afterLen: newText.length,
      head: newText.slice(0, 240) + (newText.length > 240 ? "…" : ""),
    };
  }

  if (apply) {
    // All-or-nothing writes: snapshot first; revert on any write failure.
    const snapshot: Record<string, string | null> = { ...currentTexts };
    const written: string[] = [];
    try {
      for (const [file, newText] of Object.entries(applied.newTextsByFile)) {
        const abs = await resolveSafe(clonePath, file);
        if (newText === "") {
          await fs.unlink(abs).catch(() => {
            /* missing is fine for delete */
          });
        } else {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, newText, "utf8");
        }
        written.push(file);
      }
    } catch (err) {
      // Best-effort restore prior content for files already written.
      for (const file of written) {
        try {
          const abs = await resolveSafe(clonePath, file);
          const before = snapshot[file];
          if (before == null) {
            await fs.unlink(abs).catch(() => {});
          } else {
            await fs.writeFile(abs, before, "utf8");
          }
        } catch {
          /* restore best-effort */
        }
      }
      return {
        ok: false,
        error: `propose_hunks apply write failed (reverted ${written.length} file(s)): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    ok: true,
    output: JSON.stringify({
      ok: true,
      applied: apply,
      files: Object.keys(applied.newTextsByFile),
      previews,
      note: apply
        ? "Files written to the working tree. Still emit final JSON {\"hunks\":[...]} (or confirm with matching hunks / skip if done) so the runner commits."
        : "Dry-run only (set apply:true to write). Hunks would apply successfully — include them in your final JSON response to commit.",
    }),
  };
}

// ---------------------------------------------------------------------------
// Per-tool handlers.
// ---------------------------------------------------------------------------

export async function readTool(clone: string, args: Record<string, unknown>, unrestricted = false): Promise<ToolResult> {
  const p = String(args.path ?? "");
  if (!p) return { ok: false, error: "read: missing `path` arg" };
  try {
    const abs = await resolveSafe(clone, p);
    const st = await fs.stat(abs);
    if (st.isDirectory()) {
      const cloneReal = await fs.realpath(clone);
      const rel = path.relative(cloneReal, abs).replace(/\\/g, "/") || ".";
      const listing = await listTool(clone, { path: rel });
      if (!listing.ok) return listing;
      return {
        ok: true,
        output: `(read: "${p}" is a directory — listing contents)\n${listing.output}`,
      };
    }
    const text = await fs.readFile(abs, "utf8");
    // Cap output at 200 KB so a misclick doesn't dump a giant file
    // into the model's context.
    if (unrestricted) return { ok: true, output: text };
    const CAP = 200 * 1024;
    return { ok: true, output: text.length > CAP ? text.slice(0, CAP) + "\n…(truncated)" : text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listTool(clone: string, args: Record<string, unknown>): Promise<ToolResult> {
  const p = String(args.path ?? ".");
  try {
    const abs = await resolveSafe(clone, p);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith(".git"))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (lines.length === 0) {
      return { ok: true, output: `(empty directory: ${p})` };
    }
    return { ok: true, output: lines.join("\n") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function globTool(clone: string, args: Record<string, unknown>, unrestricted = false): Promise<ToolResult> {
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
        if (e.name.startsWith(".git") || (!unrestricted && e.name === "node_modules")) continue;
        const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(childRel);
        else if (matchesGlob(childRel, pattern)) matches.push(childRel);
        if (!unrestricted && matches.length >= 500) return;
      }
    };
    await walk("");
    if (matches.length === 0) {
      return { ok: true, output: `(no files matched pattern: ${pattern})` };
    }
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

const MAX_GREP_PATTERN_LEN = 200;

async function grepFileForPattern(
  abs: string,
  clone: string,
  re: RegExp,
  hits: string[],
  unrestricted: boolean,
): Promise<void> {
  try {
    const text = await fs.readFile(abs, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const rel = path.relative(clone, abs).replace(/\\/g, "/");
        hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`);
        if (!unrestricted && hits.length >= 200) return;
      }
    }
  } catch {
    // skip unreadable files (binary, etc.)
  }
}

export async function grepTool(clone: string, args: Record<string, unknown>, unrestricted = false): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return { ok: false, error: "grep: missing `pattern` arg" };
  if (pattern.length > MAX_GREP_PATTERN_LEN) {
    return { ok: false, error: `grep: pattern exceeds ${MAX_GREP_PATTERN_LEN} characters` };
  }
  const subdir = String(args.path ?? ".");
  try {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return { ok: false, error: "grep: invalid regular expression" };
    }
    const root = await resolveSafe(clone, subdir);
    const hits: string[] = [];
    const st = await fs.stat(root);
    if (st.isFile()) {
      await grepFileForPattern(root, clone, re, hits, unrestricted);
    } else {
      const walk = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith(".git") || (!unrestricted && e.name === "node_modules")) continue;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) await walk(abs);
          else if (e.isFile()) await grepFileForPattern(abs, clone, re, hits, unrestricted);
        }
      };
      await walk(root);
    }
    if (hits.length === 0) {
      const scope = subdir && subdir !== "." ? ` in ${subdir}` : "";
      return { ok: true, output: `(no matches for pattern "${pattern}"${scope})` };
    }
    return { ok: true, output: hits.join("\n") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Unix CLI tools agents often type into bash. On Windows they print
 * "'grep' is not recognized…" on the host shell. Prefer swarm tools.
 */
const UNIX_SHELL_BINARIES = new Set([
  "grep",
  "rg",
  "egrep",
  "fgrep",
  "find",
  "cat",
  "head",
  "tail",
  "sed",
  "awk",
  "ls",
  "which",
  "xargs",
  "wc",
  "sort",
  "uniq",
  "tr",
  "cut",
  "tee",
  "less",
  "more",
]);

/** First shell token (skip env VAR=val prefixes). */
function firstShellBinary(command: string): string {
  const cleaned = command.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  const token = cleaned.split(/[\s|;&]+/)[0] ?? "";
  // strip path: /usr/bin/grep → grep
  return token.replace(/^.*[/\\]/, "").toLowerCase();
}

/**
 * Map simple Unix one-liners onto in-process tools so Windows agents don't
 * shell out to missing binaries. Returns null when the command should run as-is.
 */
async function tryFulfillUnixBashViaTools(
  clone: string,
  command: string,
): Promise<ToolResult | null> {
  const trimmed = command.trim();
  // RR-E: allow simple two-step `cmd1 && cmd2` when both rewrite cleanly.
  if (/\n/.test(trimmed)) return null;
  if (/[|;]/.test(trimmed)) return null;
  if (/&&/.test(trimmed)) {
    const parts = trimmed.split(/\s*&&\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2) {
      const a = await tryFulfillUnixBashViaTools(clone, parts[0]!);
      if (!a || !a.ok) return a;
      const b = await tryFulfillUnixBashViaTools(clone, parts[1]!);
      if (!b) return null;
      if (!b.ok) return b;
      return {
        ok: true,
        output: [a.output, b.output].filter(Boolean).join("\n"),
      };
    }
    return null;
  }

  // grep / rg / egrep [-nri] PATTERN [PATH]
  const grepM =
    /^(?:grep|egrep|fgrep|rg)(?:\s+-[nriE]+)*\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(\S.*)?$/i.exec(
      trimmed,
    );
  if (grepM) {
    const pattern = grepM[1] ?? grepM[2] ?? grepM[3] ?? "";
    let pathArg = (grepM[4] ?? ".").trim();
    if (!pathArg || pathArg === "--" || pathArg.startsWith("-")) pathArg = ".";
    return grepTool(clone, { pattern, path: pathArg });
  }

  // cat / type FILE  → read
  const catM = /^(?:cat|type)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i.exec(trimmed);
  if (catM) {
    const p = catM[1] ?? catM[2] ?? catM[3] ?? "";
    if (p) return readTool(clone, { path: p });
  }

  // ls / dir [PATH] → list
  const lsM = /^(?:ls|dir)(?:\s+(?:"([^"]+)"|'([^']+)'|(\S+)))?\s*$/i.exec(trimmed);
  if (lsM) {
    const p = lsM[1] ?? lsM[2] ?? lsM[3] ?? ".";
    return listTool(clone, { path: p });
  }

  // head [-n N] FILE → read (caller sees full file; good enough for agents)
  const headM =
    /^head(?:\s+-n\s+(\d+))?\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i.exec(trimmed);
  if (headM) {
    const p = headM[2] ?? headM[3] ?? headM[4] ?? "";
    if (p) {
      const r = await readTool(clone, { path: p });
      if (!r.ok) return r;
      const n = headM[1] ? Number(headM[1]) : 20;
      const lines = r.output.split("\n").slice(0, Math.max(1, n));
      return { ok: true, output: lines.join("\n") };
    }
  }

  // find . -name '*.ts' / find PATH -name PATTERN → glob
  const findM =
    /^find\s+(\S+)\s+-name\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i.exec(trimmed);
  if (findM) {
    const base = findM[1] === "." ? "" : findM[1].replace(/^\.\//, "");
    const name = findM[2] ?? findM[3] ?? findM[4] ?? "*";
    const pattern = base ? `${base.replace(/\\/g, "/")}/${name}` : `**/${name}`;
    return globTool(clone, { pattern });
  }

  // cd PATH && rest — only rewrite rest if pure (cd alone is no-op list)
  const cdOnly = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i.exec(trimmed);
  if (cdOnly) {
    const p = cdOnly[1] ?? cdOnly[2] ?? cdOnly[3] ?? ".";
    return listTool(clone, { path: p });
  }

  return null;
}

function windowsUnixBashHint(binary: string): string {
  const map: Record<string, string> = {
    grep: 'use the swarm **grep** tool: {tool:"grep", args:{pattern:"…", path:"."}}',
    egrep: 'use the swarm **grep** tool',
    fgrep: 'use the swarm **grep** tool',
    rg: 'use the swarm **grep** tool',
    find: 'use the swarm **glob** tool: {tool:"glob", args:{pattern:"**/*.ts"}}',
    cat: 'use the swarm **read** tool: {tool:"read", args:{path:"file"}}',
    head: 'use the swarm **read** tool',
    tail: 'use the swarm **read** tool',
    ls: 'use the swarm **list** tool: {tool:"list", args:{path:"."}}',
    which: "use where.exe on Windows, or prefer swarm tools",
  };
  const tip = map[binary] ?? "prefer swarm read/grep/glob/list tools";
  return (
    `bash: \`${binary}\` is not available as a Windows shell command. ${tip}. ` +
    `Do not shell out to Unix utilities on this host.`
  );
}

export async function bashTool(
  clone: string,
  args: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<ToolResult> {
  const command = String(args.command ?? "");
  if (!command) return { ok: false, error: "bash: missing `command` arg" };
  // Policy: any non-empty shell command is allowed (including &&, pipes, cd).
  // Still bound to clone cwd + wall-clock timeout (ToolDispatcher sandbox).
  const allow = checkBuildCommand(command);
  if (!allow.ok) {
    return { ok: false, error: `bash refused: ${allow.reason ?? "(no reason)"}` };
  }

  // Prefer in-process tools for simple Unix CLIs (especially Windows).
  const rewritten = await tryFulfillUnixBashViaTools(clone, command);
  if (rewritten) return rewritten;

  const binary = firstShellBinary(command);
  if (process.platform === "win32" && UNIX_SHELL_BINARIES.has(binary)) {
    // Complex pipeline (grep | …) or flags we didn't rewrite — fail closed
    // with guidance instead of spamming cmd.exe "'grep' is not recognized".
    return { ok: false, error: windowsUnixBashHint(binary) };
  }

  const timeoutMs = opts?.timeoutMs ?? BASH_TIMEOUT_MS;

  try {
    // Validate cwd so we don't get opaque "The system cannot find the path specified."
    try {
      await fs.access(clone);
    } catch {
      return { ok: false, error: `bash: clone cwd not found: ${clone}` };
    }

    const out = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      // shell:true so agents can use `cd … && …`, pipes, etc.
      // Explicit stdio pipes — never inherit (avoids cmd.exe noise on the server console).
      const child = spawn(command, [], {
        cwd: clone,
        shell: true,
        windowsHide: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2_000).unref?.();
      }, timeoutMs);
      child.stdout?.on("data", (c: Buffer) => {
        if (stdout.length < BASH_OUTPUT_CAP) stdout += c.toString();
      });
      child.stderr?.on("data", (c: Buffer) => {
        if (stderr.length < BASH_OUTPUT_CAP) stderr += c.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (killed) {
          reject(Object.assign(new Error("timeout"), { killed: true, stdout, stderr }));
          return;
        }
        if (code !== 0 && code !== null) {
          reject(Object.assign(new Error(`exit ${code}`), { stdout, stderr, code }));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    const combined = (out.stdout ?? "") + (out.stderr ? `\n[stderr]\n${out.stderr}` : "");
    return {
      ok: true,
      output:
        combined.length > BASH_OUTPUT_CAP
          ? combined.slice(0, BASH_OUTPUT_CAP) + "\n…(truncated)"
          : combined,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    const stdout = (e.stdout ?? "").toString();
    const stderr = (e.stderr ?? "").toString();
    let detail = stderr.trim() || stdout.trim() || (e.message ?? "exec failed");
    // Windows cmd noise → clearer agent-facing message
    if (/not recognized as an internal or external command/i.test(detail)) {
      const bin = firstShellBinary(command);
      if (UNIX_SHELL_BINARIES.has(bin)) {
        detail = windowsUnixBashHint(bin);
      } else {
        detail =
          `Command not found on this Windows host (${bin || "unknown"}). ` +
          `Prefer swarm tools (read/grep/glob/list) or a Windows-available binary. Original: ${detail.slice(0, 200)}`;
      }
    } else if (/The system cannot find the path specified/i.test(detail)) {
      detail =
        `Path not found (Windows). Use repo-relative paths under the clone; avoid Unix-only paths. ` +
        `cwd=${clone}. Detail: ${detail.slice(0, 200)}`;
    }
    if (e.killed) {
      return {
        ok: false,
        error: `bash killed after ${Math.round(timeoutMs / 1000)}s timeout: ${detail.slice(-500)}`,
      };
    }
    return { ok: false, error: `bash exited non-zero: ${detail.slice(-700)}` };
  }
}

const WRITE_MAX_CHARS = 800_000;

/**
 * Write full file contents to the working tree (git-native collaboration).
 * Prefer this over inventing search/replace hunks when rewriting large regions.
 */
export async function writeTool(
  clonePath: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const file = String(args.path ?? args.file ?? "").trim();
  if (!file) return { ok: false, error: "write: missing path/file" };
  const content = args.content ?? args.contents;
  if (typeof content !== "string") {
    return { ok: false, error: "write: missing string content/contents" };
  }
  if (content.length > WRITE_MAX_CHARS) {
    return {
      ok: false,
      error: `write: content too large (${content.length} > ${WRITE_MAX_CHARS})`,
    };
  }
  try {
    const abs = await resolveSafe(clonePath, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return {
      ok: true,
      output: `wrote ${file} (${content.length} chars). Working tree dirty — use git status / final git envelope to commit.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `write failed: ${msg}` };
  }
}

/**
 * Search/replace once in a file on disk (git-native mid-turn edit).
 */
export async function editTool(
  clonePath: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const file = String(args.path ?? args.file ?? "").trim();
  const search = args.search ?? args.old_string;
  const replace = args.replace ?? args.new_string;
  if (!file) return { ok: false, error: "edit: missing path/file" };
  if (typeof search !== "string" || search.length === 0) {
    return { ok: false, error: "edit: missing search/old_string" };
  }
  if (typeof replace !== "string") {
    return { ok: false, error: "edit: missing replace/new_string" };
  }
  try {
    const abs = await resolveSafe(clonePath, file);
    const before = await fs.readFile(abs, "utf8");
    const count = before.split(search).length - 1;
    if (count === 0) {
      return {
        ok: false,
        error: `edit: search not found in ${file} (0 matches). Read the file and re-anchor.`,
      };
    }
    if (count > 1 && args.allowMultiple !== true) {
      return {
        ok: false,
        error: `edit: search matches ${count} times in ${file} — pass allowMultiple:true or use a unique search.`,
      };
    }
    const after =
      args.allowMultiple === true
        ? before.split(search).join(replace)
        : before.replace(search, replace);
    await fs.writeFile(abs, after, "utf8");
    return {
      ok: true,
      output: `edited ${file} (${count} replacement(s)). Working tree dirty.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `edit failed: ${msg}` };
  }
}

/** git status --porcelain under the clone (native git collaboration). */
export async function gitStatusTool(clonePath: string): Promise<ToolResult> {
  return bashTool(clonePath, { command: "git status --porcelain" }, { timeoutMs: 30_000 });
}

/** git diff (optionally -- path). */
export async function gitDiffTool(
  clonePath: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const pathArg = String(args.path ?? args.file ?? "").trim();
  const staged = args.staged === true;
  const cmd = staged
    ? pathArg
      ? `git diff --cached -- ${JSON.stringify(pathArg).slice(1, -1)}`
      : "git diff --cached"
    : pathArg
      ? `git diff -- ${pathArg}`
      : "git diff";
  // Avoid broken quoting — use simple form
  const simple = staged
    ? pathArg
      ? `git diff --cached -- "${pathArg.replace(/"/g, "")}"`
      : "git diff --cached"
    : pathArg
      ? `git diff -- "${pathArg.replace(/"/g, "")}"`
      : "git diff";
  void cmd;
  return bashTool(clonePath, { command: simple }, { timeoutMs: 60_000 });
}
