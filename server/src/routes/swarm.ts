import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import type { Orchestrator } from "../services/Orchestrator.js";
import { deriveCloneDir } from "../services/RepoService.js";

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

  r.get("/status", (_req: Request, res: Response) => {
    res.json(orch.status());
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
    };
  }
  return null;
}

// Cross-platform "show this directory in the user's file manager."
// Detached + unref so the spawned process doesn't keep the dev
// server alive as a child. stdio ignored so a slow file-manager
// startup doesn't block our HTTP response.
function openInOsFileManager(absPath: string): void {
  const opts = { detached: true, stdio: "ignore" as const };
  if (process.platform === "win32") {
    // `start "" <path>` opens the path in Explorer on Windows. The
    // empty title arg is REQUIRED — without it `start` treats the
    // path as the title.
    spawn("cmd", ["/c", "start", "", absPath], opts).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [absPath], opts).unref();
  } else {
    // Linux / WSL2 — xdg-open. WSL2 also has wslview as a fallback
    // but xdg-open is more portable; fall through to the user's
    // default handler.
    spawn("xdg-open", [absPath], opts).unref();
  }
}
