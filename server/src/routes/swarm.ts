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

  // Unit 52c: open the run's clone path in the OS file manager
  // (Windows Explorer / macOS Finder / xdg-open on Linux). Locked
  // down to the orchestrator's CURRENT clone path so the endpoint
  // can't be coaxed into opening arbitrary filesystem locations
  // from the LAN. Best-effort: a spawn failure surfaces as 500.
  r.post("/open", async (req: Request, res: Response) => {
    const parsed = OpenBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const requested = path.resolve(parsed.data.path);
    const status = orch.status();
    const allowed = status.localPath ? path.resolve(status.localPath) : null;
    if (!allowed || requested !== allowed) {
      res.status(403).json({
        error: "open: requested path doesn't match the active run's clonePath",
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

  return r;
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
