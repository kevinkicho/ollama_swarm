import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import type { Orchestrator } from "../services/Orchestrator.js";

const StartBody = z.object({
  repoUrl: z.string().url(),
  localPath: z.string().min(1),
  agentCount: z.number().int().min(1).max(8),
  model: z.string().optional(),
  rounds: z.number().int().min(1).max(10).optional(),
  preset: z.enum(["round-robin", "blackboard"]).default("round-robin"),
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
    try {
      await orch.start({
        repoUrl: parsed.data.repoUrl,
        localPath: parsed.data.localPath,
        agentCount: parsed.data.agentCount,
        rounds: parsed.data.rounds ?? 3,
        model: parsed.data.model ?? config.DEFAULT_MODEL,
        preset: parsed.data.preset,
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
