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
});

const SayBody = z.object({ text: z.string().min(1) });

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

  return r;
}
