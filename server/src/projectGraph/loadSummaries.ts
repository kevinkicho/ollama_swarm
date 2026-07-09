import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { extractDeliverables } from "../swarm/blackboard/summary.js";
import type { GraphRunSummary } from "./types.js";

function parseSummaryRaw(raw: string, readDir: string): GraphRunSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.startedAt !== "number") return null;

  const deliverables =
    (Array.isArray(obj.deliverables) ? obj.deliverables : undefined) ??
    extractDeliverables(String(obj.finalGitStatus ?? ""));

  return {
    runId: typeof obj.runId === "string" ? obj.runId : undefined,
    preset: typeof obj.preset === "string" ? obj.preset : undefined,
    startedAt: obj.startedAt,
    endedAt: typeof obj.endedAt === "number" ? obj.endedAt : undefined,
    stopReason: typeof obj.stopReason === "string" ? obj.stopReason : undefined,
    localPath:
      typeof obj.localPath === "string"
        ? obj.localPath
        : typeof (obj as { clonePath?: string }).clonePath === "string"
          ? (obj as { clonePath: string }).clonePath
          : readDir,
    filesChanged: typeof obj.filesChanged === "number" ? obj.filesChanged : undefined,
    deliverables: deliverables as GraphRunSummary["deliverables"],
    finalGitStatus: typeof obj.finalGitStatus === "string" ? obj.finalGitStatus : undefined,
  };
}

async function readSummariesInDir(readDir: string, seen: Set<string>, out: GraphRunSummary[]): Promise<void> {
  let entries: string[];
  try {
    entries = await fsReaddirSafe(readDir);
  } catch {
    return;
  }

  for (const e of entries) {
    if (!/^summary(?:-.*)?\.json$/.test(e)) continue;
    let raw: string;
    try {
      raw = await readFile(path.join(readDir, e), "utf8");
    } catch {
      continue;
    }
    const s = parseSummaryRaw(raw, readDir);
    if (!s?.runId) continue;
    if (seen.has(s.runId)) continue;
    seen.add(s.runId);
    out.push(s);
  }
}

async function fsReaddirSafe(dir: string): Promise<string[]> {
  return readdir(dir);
}

/** Load full graph-oriented summaries for a single clone/workspace directory. */
export async function loadSummariesForClone(cloneDir: string): Promise<GraphRunSummary[]> {
  const out: GraphRunSummary[] = [];
  const seen = new Set<string>();
  const resolvedClone = path.resolve(cloneDir);
  await readSummariesInDir(cloneDir, seen, out);

  const logsDir = path.join(cloneDir, "logs");
  try {
    const logEntries = await readdir(logsDir);
    for (const entry of logEntries) {
      const subPath = path.join(logsDir, entry);
      try {
        if (!(await stat(subPath)).isDirectory()) continue;
      } catch {
        continue;
      }
      await readSummariesInDir(subPath, seen, out);
    }
  } catch {
    // no logs/
  }

  // Canonical project-level copies: logs/<fullRunId>/summary.json
  try {
    const projectLogsRoot = path.join(process.cwd(), "logs");
    const runDirs = await readdir(projectLogsRoot);
    for (const runId of runDirs) {
      const summaryPath = path.join(projectLogsRoot, runId, "summary.json");
      let raw: string;
      try {
        raw = await readFile(summaryPath, "utf8");
      } catch {
        continue;
      }
      const s = parseSummaryRaw(raw, cloneDir);
      if (!s?.runId || seen.has(s.runId)) continue;
      const ws = s.localPath ? path.resolve(s.localPath) : "";
      if (ws !== resolvedClone) continue;
      seen.add(s.runId);
      out.push(s);
    }
  } catch {
    // no project logs/
  }

  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** Group summaries by resolved workspace (localPath). */
export function groupSummariesByWorkspace(summaries: GraphRunSummary[]): Map<string, GraphRunSummary[]> {
  const map = new Map<string, GraphRunSummary[]>();
  for (const s of summaries) {
    const ws = (s.localPath ?? "").trim();
    if (!ws) continue;
    const list = map.get(ws) ?? [];
    list.push(s);
    map.set(ws, list);
  }
  return map;
}