import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { promises as fs, readFileSync } from "node:fs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import type { Orchestrator } from "../services/Orchestrator.js";
import { deriveCloneDir, RepoService } from "../services/RepoService.js";

// `parentPath` is the folder the user points at on the setup form; the repo
// is cloned into `<parentPath>/<repo-name-from-URL>`. The older name
// `localPath` (which meant "the full clone path") survives internally as
// `RunConfig.localPath` — the route handler resolves parent+name and passes
// the full path downstream.

// Unit 32: preset-specific knob shape for role-diff's custom roles list.
// Max 16 roles (DEFAULT_ROLES has 7; we give headroom without letting the
// user stuff an unbounded transcript of guidance into every prompt).
const SwarmRoleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  guidance: z.string().trim().min(1).max(2000),
});

const StartBody = z.object({
  repoUrl: z.string().url(),
  parentPath: z.string().min(1),
  agentCount: z.number().int().min(1).max(8),
  model: z.string().optional(),
  // Bumped 2026-04-22 from .max(10) → .max(100). For blackboard, rounds
  // = max auditor invocations; the 20min wall-clock / 20 commits / 30
  // todos hard caps still bound runtime so a high `rounds` just removes
  // a tertiary cap. For non-blackboard presets, rounds maps to actual
  // work — rounds=100 with 6 agents on a serial preset (round-robin /
  // role-diff / debate-judge / stigmergy) can mean hours of wall-clock
  // and proportional cloud-token spend. Use accordingly.
  rounds: z.number().int().min(1).max(100).optional(),
  preset: z
    .enum([
      "round-robin",
      "blackboard",
      "role-diff",
      "council",
      "orchestrator-worker",
      "debate-judge",
      "map-reduce",
      "stigmergy",
    ])
    .default("round-robin"),
  // Unit 25: optional free-text directive that shapes the blackboard
  // planner's first-pass contract. Capped at 4000 chars to match the
  // README-excerpt window already in the planner seed (same order of
  // magnitude of prompt real-estate). Empty/whitespace gets treated as
  // absent — the planner only sees it when there's actual content.
  userDirective: z.string().trim().max(4000).optional(),
  // Unit 32: per-preset knobs. Validated here so the route layer is the
  // sole boundary between user input and RunConfig. Runners receive
  // already-validated values and only need to decide how to apply them.
  roles: z.array(SwarmRoleSchema).min(1).max(16).optional(),
  councilContract: z.boolean().optional(),
  proposition: z.string().trim().max(2000).optional(),
  // Unit 34: per-run ambition ratchet cap. 0 = explicitly disabled; 1-20
  // enables with that many tiers max. Absent = inherit from env.
  // Blackboard-only.
  ambitionTiers: z.number().int().min(0).max(20).optional(),
  // Unit 35: per-run critic override. Blackboard-only.
  critic: z.boolean().optional(),
  // Unit 36: user-supplied running-app URL for auditor UI verification.
  // Requires MCP_PLAYWRIGHT_ENABLED=true. Blackboard-only.
  uiUrl: z.string().url().optional(),
  // Unit 42: per-agent model overrides (blackboard-only). Each falls
  // back to `model` when absent. Validated as the same loose string
  // shape as `model` itself — opencode/Ollama is the authoritative
  // resolver.
  plannerModel: z.string().trim().min(1).max(200).optional(),
  workerModel: z.string().trim().min(1).max(200).optional(),
  // Unit 43: per-run wall-clock cap override (ms). Bounded
  // [60_000, 8 * 60 * 60_000] = 1 min … 8 h, matching the baked-in
  // default's range. Anything outside is a config bug, not a feature.
  wallClockCapMs: z
    .number()
    .int()
    .min(60_000)
    .max(8 * 60 * 60_000)
    .optional(),
  // Unit 51: reload contract + tier state from prior run's
  // blackboard-state.json instead of re-deriving via first-pass-
  // contract. Blackboard-only. Default false = existing behavior.
  resumeContract: z.boolean().optional(),
  // Unit 58: opt-in to a 4th agent dedicated to the auditor role.
  // Total agents = agentCount + 1 (auditor is extra; workers
  // unchanged). Blackboard-only.
  dedicatedAuditor: z.boolean().optional(),
  auditorModel: z.string().trim().min(1).max(200).optional(),
  // Unit 59 (59a): per-worker role bias (correctness / simplicity /
  // consistency cycling). Blackboard-only.
  specializedWorkers: z.boolean().optional(),
  // Unit 60: 3-critic ensemble (substance / regression / consistency)
  // with majority vote. Blackboard-only; only meaningful when critic
  // is enabled.
  criticEnsemble: z.boolean().optional(),
});

const SayBody = z.object({ text: z.string().min(1) });

// Unit 52c: open-clone request body. Path is the absolute path of the
// directory the user wants to open in the OS file manager. Validated
// at handler time against the orchestrator's known clone — we only
// open paths the runner is currently or was recently working in,
// never arbitrary filesystem locations.
const OpenBody = z.object({ path: z.string().min(1).max(4096) });

export function swarmRouter(orch: Orchestrator): Router {
  const r = Router();
  // Stateless helper — RepoService methods we use here (dirExists,
  // cloneStats) don't touch orchestrator state, so a fresh instance is
  // fine and avoids threading orch.opts.repos through.
  const repos = new RepoService();

  r.get("/status", (_req: Request, res: Response) => {
    res.json(orch.status());
  });

  // Preflight check (2026-04-24): lets the SetupForm preview whether a
  // Start will CLONE fresh or RESUME an existing clone BEFORE the user
  // commits. Keeps the decision visible instead of only surfacing
  // post-start via CloneBanner + the "Resuming existing clone..."
  // transcript line.
  //
  // Contract:
  //   GET /api/swarm/preflight?repoUrl=...&parentPath=...
  //   → 200 { destPath, exists, isGitRepo, alreadyPresent,
  //           priorCommits, priorChangedFiles, priorUntrackedFiles,
  //           blocker?: "not-git-repo" }
  //   → 400 on bad inputs (missing fields, unparseable URL)
  //
  // Mirrors RepoService.clone's decision logic without actually
  // cloning: if destPath exists + has .git, alreadyPresent=true + we
  // also include cloneStats. If destPath exists but is NOT a git repo,
  // we flag blocker="not-git-repo" — clone() would reject this with
  // "Destination is not empty and is not a git repo". If destPath
  // doesn't exist, alreadyPresent=false and a fresh clone would happen.
  r.get("/preflight", async (req: Request, res: Response) => {
    const repoUrl = typeof req.query.repoUrl === "string" ? req.query.repoUrl : "";
    const parentPath = typeof req.query.parentPath === "string" ? req.query.parentPath : "";
    if (!repoUrl || !parentPath) {
      res.status(400).json({ error: "repoUrl and parentPath are required" });
      return;
    }
    let destPath: string;
    try {
      destPath = deriveCloneDir(repoUrl, parentPath);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "could not derive clone directory",
      });
      return;
    }
    const exists = await repos.dirExists(destPath);
    if (!exists) {
      res.json({
        destPath,
        exists: false,
        isGitRepo: false,
        alreadyPresent: false,
        priorCommits: 0,
        priorChangedFiles: 0,
        priorUntrackedFiles: 0,
      });
      return;
    }
    const isGitRepo = await repos.dirExists(path.join(destPath, ".git"));
    if (!isGitRepo) {
      // Non-empty non-git dir — clone() would reject unless force=true.
      // Surface as a blocker so the SetupForm can warn before Start.
      res.json({
        destPath,
        exists: true,
        isGitRepo: false,
        alreadyPresent: false,
        priorCommits: 0,
        priorChangedFiles: 0,
        priorUntrackedFiles: 0,
        blocker: "not-git-repo",
      });
      return;
    }
    const stats = await repos.cloneStats(destPath);
    res.json({
      destPath,
      exists: true,
      isGitRepo: true,
      alreadyPresent: true,
      priorCommits: stats.commits,
      priorChangedFiles: stats.changedFiles,
      priorUntrackedFiles: stats.untrackedFiles,
    });
  });

  r.post("/start", async (req: Request, res: Response) => {
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    let localPath: string;
    try {
      localPath = deriveCloneDir(parsed.data.repoUrl, parsed.data.parentPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
      return;
    }
    try {
      await orch.start({
        repoUrl: parsed.data.repoUrl,
        localPath,
        agentCount: parsed.data.agentCount,
        rounds: parsed.data.rounds ?? 3,
        model: parsed.data.model ?? config.DEFAULT_MODEL,
        preset: parsed.data.preset,
        // Unit 25: pass user directive through. Already trimmed + 4000-cap-
        // validated by zod. Empty string → undefined already (zod strips).
        userDirective: parsed.data.userDirective && parsed.data.userDirective.length > 0
          ? parsed.data.userDirective
          : undefined,
        // Unit 32: per-preset knobs. Empty/absent → undefined so the
        // runners' fallback logic (DEFAULT_ROLES, env flag,
        // injected-proposition) kicks in cleanly.
        roles:
          parsed.data.roles && parsed.data.roles.length > 0
            ? parsed.data.roles
            : undefined,
        councilContract: parsed.data.councilContract,
        proposition:
          parsed.data.proposition && parsed.data.proposition.length > 0
            ? parsed.data.proposition
            : undefined,
        ambitionTiers: parsed.data.ambitionTiers,
        critic: parsed.data.critic,
        uiUrl: parsed.data.uiUrl,
        plannerModel: parsed.data.plannerModel,
        workerModel: parsed.data.workerModel,
        wallClockCapMs: parsed.data.wallClockCapMs,
        resumeContract: parsed.data.resumeContract,
        dedicatedAuditor: parsed.data.dedicatedAuditor,
        auditorModel: parsed.data.auditorModel,
        specializedWorkers: parsed.data.specializedWorkers,
        criticEnsemble: parsed.data.criticEnsemble,
      });
      res.json({ ok: true, status: orch.status() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  r.post("/stop", async (_req: Request, res: Response) => {
    try {
      await orch.stop();
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  r.post("/say", (req: Request, res: Response) => {
    const parsed = SayBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    orch.injectUser(parsed.data.text);
    res.json({ ok: true });
  });

  // Unit 52c + 52e: open a run's clone path in the OS file manager
  // (Windows Explorer / macOS Finder / xdg-open on Linux). Locked
  // down to the orchestrator's CURRENT clone path OR a sibling
  // directory in the same parent (prior runs from the run-history
  // dropdown — Unit 52e). The parent constraint is the
  // path-traversal guard: the LAN can't coax this endpoint into
  // opening arbitrary filesystem locations.
  r.post("/open", async (req: Request, res: Response) => {
    const parsed = OpenBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const requested = path.resolve(parsed.data.path);
    const status = orch.status();
    const activeClone = status.localPath ? path.resolve(status.localPath) : null;
    if (!activeClone) {
      res.status(403).json({ error: "open: no active run; nothing to compare against" });
      return;
    }
    const activeParent = path.dirname(activeClone);
    const requestedParent = path.dirname(requested);
    const isActive = requested === activeClone;
    const isSibling = requestedParent === activeParent && requested !== activeParent;
    if (!isActive && !isSibling) {
      res.status(403).json({
        error: "open: requested path is not the active clone or a sibling of it",
      });
      return;
    }
    try {
      // Verify it actually exists before shelling out — saves us a
      // confusing OS-level error and lets us return a clean 404.
      const stat = await fs.stat(requested);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: "open: path is not a directory" });
        return;
      }
    } catch {
      res.status(404).json({ error: "open: path does not exist" });
      return;
    }
    try {
      openInOsFileManager(requested);
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `open: spawn failed (${msg})` });
    }
  });

  // Unit 52e: list prior runs discoverable in the active run's
  // parent directory. Each entry carries the headline summary fields
  // so the UI dropdown + modal can render without further fetches.
  // Returns 200 with an empty list when no run is active or the
  // parent dir is unreadable — never throws.
  r.get("/runs", async (_req: Request, res: Response) => {
    const status = orch.status();
    if (!status.localPath) {
      res.json({ runs: [] });
      return;
    }
    const parent = path.dirname(path.resolve(status.localPath));
    let entries: string[];
    try {
      entries = await fs.readdir(parent);
    } catch {
      res.json({ runs: [] });
      return;
    }
    const activeClone = path.resolve(status.localPath);
    const runs: RunSummaryDigest[] = [];
    for (const name of entries) {
      const cloneDir = path.join(parent, name);
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(cloneDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      // Try the latest pointer first (Unit 49: summary.json); fall
      // back to scanning for the newest summary-*.json. Fast happy
      // path; defensive on older clones.
      const digest = await readRunDigest(cloneDir, name);
      if (digest) {
        digest.isActive = cloneDir === activeClone;
        runs.push(digest);
      }
    }
    // Newest first by startedAt (descending). Falls back to dir name
    // when startedAt is missing (shouldn't happen with a real
    // summary, but defensive).
    runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    res.json({ runs });
  });

  return r;
}

// Unit 52e: thin digest of a run's summary for the history dropdown.
// Strict subset of RunSummary's surface — anything bigger goes via a
// follow-up modal fetch (or we just open the folder).
interface RunSummaryDigest {
  name: string;
  clonePath: string;
  preset: string;
  model: string;
  startedAt: number;
  endedAt: number;
  wallClockMs: number;
  stopReason?: string;
  commits?: number;
  totalTodos?: number;
  hasContract: boolean;
  isActive: boolean;
  // Task #36: runId from summary.json (absent on pre-task-36 writes).
  // Enables click-to-copy in the dropdown that matches the live
  // IdentityStrip chip so transcript references like "run 7302..."
  // can be located in the history list.
  runId?: string;
}

async function readRunDigest(
  cloneDir: string,
  name: string,
): Promise<RunSummaryDigest | null> {
  // Latest pointer first.
  const candidates = [path.join(cloneDir, "summary.json")];
  try {
    const all = await fs.readdir(cloneDir);
    const perRun = all
      .filter((e) => /^summary-.+\.json$/.test(e))
      .sort()
      .reverse();
    for (const e of perRun) candidates.push(path.join(cloneDir, e));
  } catch {
    // ignore — latest pointer alone is fine
  }
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.preset !== "string" || typeof obj.startedAt !== "number") continue;
    const contract = obj.contract as Record<string, unknown> | undefined;
    return {
      name,
      clonePath: cloneDir,
      preset: obj.preset,
      model: typeof obj.model === "string" ? obj.model : "(unknown)",
      startedAt: obj.startedAt,
      endedAt: typeof obj.endedAt === "number" ? obj.endedAt : 0,
      wallClockMs: typeof obj.wallClockMs === "number" ? obj.wallClockMs : 0,
      stopReason: typeof obj.stopReason === "string" ? obj.stopReason : undefined,
      commits: typeof obj.commits === "number" ? obj.commits : undefined,
      totalTodos: typeof obj.totalTodos === "number" ? obj.totalTodos : undefined,
      hasContract: contract !== undefined && Array.isArray(contract.criteria),
      isActive: false,
      runId: typeof obj.runId === "string" ? obj.runId : undefined,
    };
  }
  return null;
}

// True iff this Node process is running inside WSL2 — Linux uname,
// but the kernel string includes "microsoft". We treat WSL2 as a
// distinct platform from native Linux because xdg-open is rarely
// installed there but explorer.exe is always reachable.
function isWsl2(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    const release = readFileSync("/proc/version", "utf8");
    return /microsoft/i.test(release);
  } catch {
    return false;
  }
}

// Cross-platform "show this directory in the user's file manager."
// Detached + unref so the spawned process doesn't keep the dev
// server alive as a child. stdio ignored so a slow file-manager
// startup doesn't block our HTTP response.
//
// All branches attach an `error` handler to the spawned child so an
// ENOENT (handler binary not installed) becomes a logged warning
// instead of an uncaughtException that takes the dev server down.
// The HTTP response has already been sent by the time the spawn
// errors, so there's nothing to surface back to the caller — we just
// want to fail safe.
function openInOsFileManager(absPath: string): void {
  const opts = { detached: true, stdio: "ignore" as const };

  // WSL2 → use Windows Explorer via the wslpath-converted path.
  // Falls back to a no-op if wslpath isn't on PATH (rare; ships
  // with every WSL2 distro by default).
  if (isWsl2()) {
    const winPath = wslPathToWindows(absPath) ?? absPath;
    const child = spawn("explorer.exe", [winPath], opts);
    child.on("error", (err) => {
      console.warn(`[open] explorer.exe spawn failed in WSL2: ${err.message}`);
    });
    child.unref();
    return;
  }

  if (process.platform === "win32") {
    // `start "" <path>` opens the path in Explorer on Windows. The
    // empty title arg is REQUIRED — without it `start` treats the
    // path as the title.
    const child = spawn("cmd", ["/c", "start", "", absPath], opts);
    child.on("error", (err) => {
      console.warn(`[open] cmd /c start spawn failed: ${err.message}`);
    });
    child.unref();
    return;
  }

  if (process.platform === "darwin") {
    const child = spawn("open", [absPath], opts);
    child.on("error", (err) => {
      console.warn(`[open] open(1) spawn failed: ${err.message}`);
    });
    child.unref();
    return;
  }

  // Native Linux — xdg-open is the standard. If it's not installed
  // (minimal containers, headless boxes), the error handler swallows
  // the ENOENT instead of crashing the process.
  const child = spawn("xdg-open", [absPath], opts);
  child.on("error", (err) => {
    console.warn(
      `[open] xdg-open spawn failed: ${err.message}. Install xdg-utils to enable open-in-file-manager.`,
    );
  });
  child.unref();
}

// Convert a WSL2 Linux path to its Windows-visible form via the
// `wslpath` utility. Returns null on any failure (utility missing,
// non-zero exit, empty stdout) so callers can fall back gracefully.
// Synchronous because we already do filesystem I/O around it and the
// utility returns instantly.
function wslPathToWindows(linuxPath: string): string | null {
  try {
    const result = spawnSync("wslpath", ["-w", linuxPath], { encoding: "utf8" });
    if (result.status !== 0) return null;
    const out = (result.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
