/**
 * Disk-first worker settlement (lean agent model).
 *
 * When the model used write/edit tools successfully but failed to emit a
 * final JSON envelope (empty / pure-think / unparseable), recover a synthetic
 * {workingTree:true} parse so the auditor can still approve/deny git reality.
 */

import { simpleGit } from "simple-git";
import type { ToolTraceEntry } from "../toolCallTranscript.js";
import { normalizeRepoPath } from "./prompts/worker.js";
import type { parseWorkerResponse } from "./prompts/worker.js";

export type OkWorkerParse = Extract<ReturnType<typeof parseWorkerResponse>, { ok: true }>;

const MUTATE_TOOLS = new Set(["write", "edit", "propose_hunks"]);

/**
 * Paths touched by successful write/edit tools (from buffered tool trace).
 * Preview format from formatToolInvokePreview: `path → output…`
 */
export function pathsFromSuccessfulMutateTools(
  trace: readonly ToolTraceEntry[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of trace) {
    if (!e.ok || !MUTATE_TOOLS.has(e.tool)) continue;
    // Prefer "path → …"; fall back to first token without arrow.
    let raw = e.preview.split("→")[0]?.trim() ?? "";
    if (!raw || raw.startsWith("(")) continue;
    // Drop trailing " →" artifacts
    raw = raw.replace(/\s+$/, "");
    const norm = normalizeRepoPath(raw);
    if (!norm || seen.has(norm)) continue;
    // Skip non-path previews
    if (/\s/.test(norm) && !norm.includes("/") && !norm.includes(".")) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/** Prefer expectedFiles intersection; else all tool-touched paths. */
export function pickDiskFirstFiles(
  expectedFiles: readonly string[],
  toolPaths: readonly string[],
  dirtyPaths: readonly string[] = [],
): string[] {
  const expected = expectedFiles.map(normalizeRepoPath).filter(Boolean);
  const tools = toolPaths.map(normalizeRepoPath).filter(Boolean);
  const dirty = dirtyPaths.map(normalizeRepoPath).filter(Boolean);

  if (expected.length > 0) {
    const expSet = new Set(expected);
    const hit = [
      ...tools.filter((p) => expSet.has(p) || expected.some((e) => pathsRelated(e, p))),
      ...dirty.filter((p) => expSet.has(p) || expected.some((e) => pathsRelated(e, p))),
    ];
    const uniq = [...new Set(hit)];
    if (uniq.length > 0) return uniq;
    // Tools wrote expected paths under different casing / prefix
    if (tools.length > 0) return [...new Set(tools)];
  }
  if (tools.length > 0) return [...new Set(tools)];
  if (dirty.length > 0) return [...new Set(dirty)].slice(0, 8);
  return [];
}

function pathsRelated(a: string, b: string): boolean {
  if (a === b) return true;
  const aBase = a.split("/").pop() ?? a;
  const bBase = b.split("/").pop() ?? b;
  if (aBase && aBase === bBase) return true;
  return false;
}

/** Porcelain paths relative to clone (no renames complexity). */
export async function listGitDirtyPaths(clonePath: string): Promise<string[]> {
  const raw = clonePath?.trim();
  if (!raw) return [];
  try {
    const git = simpleGit(raw);
    const st = await git.status();
    const files = [
      ...st.files.map((f) => f.path),
      ...st.not_added,
      ...st.created,
      ...st.modified,
      ...st.deleted,
    ];
    return [...new Set(files.map((p) => normalizeRepoPath(String(p))).filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * Build a synthetic workingTree parse result when tools/git show real disk work
 * but the model never emitted a valid finish envelope.
 */
export function synthesizeWorkingTreeParse(
  files: readonly string[],
  message: string,
): OkWorkerParse | null {
  const cleaned = [...new Set(files.map(normalizeRepoPath).filter(Boolean))];
  if (cleaned.length === 0) return null;
  return {
    ok: true,
    hunks: [],
    workingTree: true,
    filesTouched: cleaned,
    gitMessage: (message || "worker disk changes").slice(0, 500),
  };
}

export async function tryDiskFirstWorkerParse(opts: {
  expectedFiles: readonly string[];
  toolTrace: readonly ToolTraceEntry[];
  clonePath: string;
  todoDescription: string;
}): Promise<OkWorkerParse | null> {
  const toolPaths = pathsFromSuccessfulMutateTools(opts.toolTrace);
  const dirty =
    toolPaths.length > 0
      ? [] // enough signal from tools; skip git if we have writes
      : await listGitDirtyPaths(opts.clonePath);
  // Always merge dirty when tools wrote something that might not match expected
  const dirtyAll =
    toolPaths.length > 0
      ? await listGitDirtyPaths(opts.clonePath).catch(() => [] as string[])
      : dirty;
  const files = pickDiskFirstFiles(opts.expectedFiles, toolPaths, dirtyAll);
  if (files.length === 0) return null;
  // Require at least one successful mutate tool OR dirty git — avoid
  // false settle from empty parse alone.
  if (toolPaths.length === 0 && dirtyAll.length === 0) return null;
  if (toolPaths.length === 0 && dirtyAll.length > 0) {
    // Dirty tree without write/edit tools this turn — only settle if dirty
    // intersects expected files (peer commit thrash protection).
    const expected = new Set(opts.expectedFiles.map(normalizeRepoPath));
    if (expected.size > 0 && !files.some((f) => expected.has(f))) return null;
  }
  return synthesizeWorkingTreeParse(
    files,
    opts.todoDescription.slice(0, 120) || "disk-first working tree",
  );
}
