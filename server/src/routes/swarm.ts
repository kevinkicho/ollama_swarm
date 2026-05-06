import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { promises as fs, readFileSync } from "node:fs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { TopologySchema, deriveLegacyFields, synthesizeTopology } from "../../../shared/src/topology.js";
import { config } from "../config.js";
import { validateContinuousMode } from "./continuousMode.js";
import type { Orchestrator } from "../services/Orchestrator.js";
import { deriveCloneDir, RepoService } from "../services/RepoService.js";
import { normalizeWslPath } from "../services/pathNormalize.js";
import { preflightDiskCheck } from "../swarm/preflightDiskCheck.js";
import { projectRunCost, exceedsBudget } from "../swarm/preflightCostProjector.js";
import { decideStopAction } from "../swarm/drainStopPolicy.js";

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
      "orchestrator-worker-deep",
      "debate-judge",
      "map-reduce",
      "stigmergy",
      "baseline",
      "moa",
      "pipeline",
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
  // #296 (2026-04-28): pre-commit verify command (e.g. "npm test").
  // Bounded length so we don't accept a 100KB shell script via the
  // route. Trimmed; empty string → undefined → skip the gate
  // entirely (legacy behavior). Blackboard-only.
  verifyCommand: z.string().trim().min(1).max(500).optional(),
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
  // #87 (2026-05-01): self-consistency K for worker hunks. K > 1 runs
  // the worker prompt K times per todo + applies the majority-voted
  // hunks envelope. Capped at 5 to bound token cost. Blackboard-only.
  selfConsistencyK: z.number().int().min(1).max(5).optional(),
  // #93 deeper (2026-05-01): MoA aggregator count + convergence threshold.
  // moaAggregatorCount > 1 = K aggregators in parallel, pick most-central.
  // moaConvergenceThreshold gates round-to-round early stop. MoA-only.
  moaAggregatorCount: z.number().int().min(1).max(3).optional(),
  moaConvergenceThreshold: z.number().min(0).max(1).optional(),
  // #98 (2026-05-01): heterogeneous models per MoA layer. Tests the
  // value prop "N small + 1 big > 1 big alone" cleanly. MoA-only.
  moaProposerModel: z.string().trim().min(1).max(200).optional(),
  moaAggregatorModel: z.string().trim().min(1).max(200).optional(),
  // T196 + T199 (2026-05-04): per-tier model arrays + extras for the
  // open-weights-parallelism value prop. Each is opt-in, falls back
  // to cfg.model when absent.
  moaProposerModels: z
    .array(z.string().trim().min(0).max(200))
    .max(20)
    .optional(),
  moaAggregationLevels: z.number().int().min(1).max(4).optional(),
  orchestratorModel: z.string().trim().min(1).max(200).optional(),
  midLeadModel: z.string().trim().min(1).max(200).optional(),
  dispositionModels: z
    .object({
      critic: z.string().trim().min(1).max(200).optional(),
      synthesizer: z.string().trim().min(1).max(200).optional(),
      "gap-finder": z.string().trim().min(1).max(200).optional(),
      builder: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
  // T199 cluster of opt-in flags wired in earlier passes (T197/T198/T199).
  importGraphSlicing: z.boolean().optional(),
  crossClusterDiscovery: z.boolean().optional(),
  streamingReducer: z.boolean().optional(),
  dynamicRoles: z.boolean().optional(),
  parallelPropositions: z.boolean().optional(),
  twoStageMoA: z.boolean().optional(),
  bidirectionalRefinement: z.boolean().optional(),
  baselineSelfCritique: z.boolean().optional(),
  baselineAttempts: z.number().int().min(1).max(5).optional(),
  testDrivenTodos: z.boolean().optional(),
  parallelHypothesis: z.boolean().optional(),
  chainTo: z.enum(["blackboard", "baseline"]).optional(),
  adaptiveWorkers: z
    .object({
      min: z.number().int().min(1).max(20),
      max: z.number().int().min(1).max(20),
    })
    .optional(),
  // Task #102 (2026-04-25): opt-in post-verdict "build" round for
  // debate-judge — PRO becomes implementer, CON reviewer, JUDGE
  // signoff. Default off; debate-judge-only.
  executeNextAction: z.boolean().optional(),
  // Task #124: optional per-run hard cap on total tokens (prompt +
  // response) consumed. User-supplied number, no defaults.
  tokenBudget: z.number().int().positive().optional(),
  // Phase 2 of #314: optional per-run dollar ceiling for paid
  // providers. Capped at $100 to prevent obvious typos (extra zero)
  // from authorizing a runaway run; users with legitimately bigger
  // budgets can lift this in the schema after deliberate review.
  maxCostUsd: z.number().positive().max(100).optional(),
  // W13 wiring (2026-05-04): per-run provider failover chain. When
  // set, overrides the env-derived SWARM_PROVIDER_FAILOVER list. Each
  // element is a provider-prefixed model string (e.g.
  // "anthropic/claude-haiku-4-5", "glm-5.1:cloud"). Capped at 8
  // entries to keep failover bounded.
  providerFailover: z.array(z.string().min(1)).max(8).optional(),
  // Task #127: when no userDirective is set, auto-generate one via a
  // pre-pass. Default true (caller can pass false to disable).
  autoGenerateGoals: z.boolean().optional(),
  // Task #129: post-completion stretch-goal reflection pass — one
  // planner prompt asks "what would the BEST version of this work
  // have done?" and tags the answer for next-run / user review.
  // Default true; pass false to skip.
  autoStretchReflection: z.boolean().optional(),
  // Task #128: per-commit verifier (claim-vs-diff). Default off; opt-in.
  verifier: z.boolean().optional(),
  // Per-run override for the V2 worker pipeline. When set, wins over
  // the USE_WORKER_PIPELINE_V2 env flag for THIS run only. Lets the
  // user A/B without restarting the dev server. Blackboard-only;
  // ignored by discussion presets. (See SwarmRunner RunConfig comment
  // for context.)
  useWorkerPipeline: z.boolean().optional(),
  // Issue #3: override the sibling-model fallback used when the
  // planner returns 0 valid todos. Set to the same value as the
  // planner model to disable fallback. Blackboard-only.
  plannerFallbackModel: z.string().trim().min(1).max(200).optional(),
  // Task #132: continuous mode — run-against-budget instead of
  // run-against-rounds. Requires at least one budget cap (tokenBudget
  // or wallClockCapMs); the start handler rejects otherwise.
  continuous: z.boolean().optional(),
  // Task #130: persistent cross-run memory (.swarm-memory.jsonl).
  // Read at planner-seed time + written at run-end (post-stretch).
  // Default true.
  autoMemory: z.boolean().optional(),
  // Task #177: long-horizon DESIGN memory at <clone>/.swarm-design/
  // (north-star + decisions + roadmap). Default true.
  autoDesignMemory: z.boolean().optional(),
  // Task #147: when true, the route auto-stops any existing runner
  // before starting the new one, instead of returning 409 "A swarm
  // is already running". Lets clients recover from a stuck-orchestrator
  // state (e.g. previous start hung in spawning phase, client gave up
  // on its HTTP request, but the server-side runner is still around).
  // Default false — explicit opt-in so the UI's normal Start button
  // can't accidentally clobber a healthy run.
  force: z.boolean().optional(),
  // Phase 1 of the topology refactor (#243): explicit per-agent specs.
  // When present, supersedes legacy fields (agentCount, plannerModel,
  // workerModel, auditorModel, dedicatedAuditor) — those are derived
  // from the topology via deriveLegacyFields() and re-injected into
  // the runner's RunConfig. When absent (older clients), the legacy
  // fields drive the run unchanged. Synthesis happens at the end of
  // the handler via synthesizeTopology(), so the post-resolution
  // RunConfig.topology is always populated for downstream phases
  // (4a History column, 4b AgentPanel mirroring) to consume.
  topology: TopologySchema.optional(),
  // Plan 5: post-round critique — 1 extra prompt/round, any discussion preset.
  postRoundCritique: z.boolean().optional(),
  // Plan 7: post-synthesis critique — 1 extra prompt after synthesis, MoA pattern.
  postSynthesisCritique: z.boolean().optional(),
  // Plan 6: rotating dispositions for blackboard workers across cycles.
  workerDispositions: z.boolean().optional(),
  // Plan 1: debate-judge auditor — PRO/CON/JUDGE replaces single-agent audit.
  debateAudit: z.boolean().optional(),
  debateAuditRounds: z.number().int().min(1).max(2).optional(),
  // Plan 2: council inside map-reduce mappers — draft→revise per slice.
  councilMappers: z.boolean().optional(),
  councilMapperRounds: z.number().int().min(1).max(3).optional(),
  // Plan 3: pheromone heatmap — cross-preset file-attention signal.
  pheromoneHotseed: z.string().trim().max(100).optional(),
  pheromoneHotFiles: z.array(z.string().min(1).max(500)).max(50).optional(),
  // Plan 4: pipeline preset — chain sub-runs with transcript/deliverable piping.
  pipeline: z.object({
    phases: z.array(z.object({
      preset: z.enum([
        "round-robin", "blackboard", "role-diff", "council",
        "orchestrator-worker", "orchestrator-worker-deep", "debate-judge",
        "map-reduce", "stigmergy", "baseline", "moa",
      ]),
      rounds: z.number().int().min(1).max(100).optional(),
      agentCount: z.number().int().min(1).max(8).optional(),
      model: z.string().trim().min(1).max(200).optional(),
    })).min(2).max(10),
    pipeMode: z.enum(["transcript", "deliverable", "both"]).optional(),
    pipeMaxEntries: z.number().int().min(1).max(100).optional(),
  }).optional(),
  rubricGrading: z.boolean().optional(),
  checkpointing: z.boolean().optional(),
});

// 2026-05-02: extended /say body with optional intent tag + targetAgent.
//   intent="suggest" → low-pressure, considered if relevant
//   intent="steer"   → reshape next planner turn (current behavior, default)
//   intent="ask"     → answer inline; do NOT change direction
//   targetAgent      → @mention routing; only this agent's prompt sees the input
// Default intent is "steer" so existing /say callers keep current semantics.
const SayBody = z.object({
  text: z.string().min(1),
  intent: z.enum(["suggest", "steer", "ask"]).optional(),
  targetAgent: z.string().min(1).max(64).optional(),
});

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
  // R6 wiring (2026-05-04): tracks the wall-clock of the last
  // /api/swarm/stop click for the double-click-within-5s detection.
  // null until the first click; carried inside the closure so it's
  // bounded to the router's lifetime.
  let lastStopClickAt: number | null = null;

  r.get("/status", (_req: Request, res: Response) => {
    res.json(orch.status());
  });

  // T-Item-MultiTenant Phase 4 (2026-05-04): list all currently active
  // runs (server-wide, not parent-dir-scoped). Distinct from
  // /api/swarm/runs which lists historical run summaries from a
  // parent directory. Multi-tenant aware UIs use this to show "all
  // runs in flight" across the host.
  r.get("/active-runs", (_req: Request, res: Response) => {
    res.json({ runs: orch.listActiveRuns() });
  });

  // T-Item-Recovery (2026-05-04): runs the persister wrote a snapshot
  // for that didn't reach a terminal phase. The user sees these on
  // server startup so they can decide whether to manually inspect
  // (today) or auto-resume (when that lands). Excludes runs the
  // orchestrator already has active in memory.
  r.get("/recoverable-runs", (_req: Request, res: Response) => {
    res.json({ runs: orch.listRecoverableRuns() });
  });

  // T-Item-Recover (2026-05-04): kick a fresh run using the cfg saved
  // in a recoverable snapshot. Returns 200 with the new runId + the
  // prior transcript (so the UI can surface what happened before).
  // 400 on schema-too-old; 404 on unknown runId; 5xx on start failure.
  r.post("/recover/:runId", async (req: Request, res: Response) => {
    const originalRunId = String(req.params.runId);
    try {
      const result = await orch.recoverRun(originalRunId);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Heuristic status mapping: snapshot-not-found / schema-too-old
      // → 4xx; everything else (start failure, etc.) → 500.
      if (/no recoverable snapshot/i.test(msg)) {
        res.status(404).json({ error: msg });
      } else if (/predates schema v2|cannot auto-resume/i.test(msg)) {
        res.status(400).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // T-Item-MultiTenant Phase 5 (2026-05-04): per-run status snapshot.
  // 404 when the runId isn't in the active map. Mirrors GET /status
  // shape but scoped to one run.
  r.get("/runs/:runId/status", (req: Request, res: Response) => {
    const runId = String(req.params.runId);
    const status = orch.statusForRun(runId);
    if (!status) {
      res.status(404).json({ error: "runId not active" });
      return;
    }
    res.json(status);
  });

  // T-Item-MultiTenant Phase 5 (2026-05-04): per-run user inject.
  r.post("/runs/:runId/say", (req: Request, res: Response) => {
    const runId = String(req.params.runId);
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (text.trim().length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const intent =
      req.body?.intent === "suggest" || req.body?.intent === "ask"
        ? req.body.intent
        : "steer";
    const targetAgent =
      typeof req.body?.targetAgent === "string" ? req.body.targetAgent : undefined;
    const ok = orch.injectUserForRun(runId, text, {
      intent,
      ...(targetAgent ? { targetAgent } : {}),
    });
    if (!ok) {
      res.status(404).json({ error: "runId not active" });
      return;
    }
    res.json({ ok: true });
  });

  // T-Item-MultiTenant Phase 5 (2026-05-04): per-run stop.
  r.post("/runs/:runId/stop", async (req: Request, res: Response) => {
    const runId = String(req.params.runId);
    const ok = await orch.stopRun(runId);
    if (!ok) {
      res.status(404).json({ error: "runId not active" });
      return;
    }
    res.json({ ok: true });
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
    const rawParentPath = typeof req.query.parentPath === "string" ? req.query.parentPath : "";
    if (!repoUrl || !rawParentPath) {
      res.status(400).json({ error: "repoUrl and parentPath are required" });
      return;
    }
    // WSL ↔ Windows boundary: clients under /mnt/c send WSL-style
    // paths; on Windows we must re-spell them as <DRIVE>:\... or
    // path.resolve will create a parallel C:\mnt\c\... tree.
    const parentPath = normalizeWslPath(rawParentPath);
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
    // Task #147: force-restart path. When the caller sets force=true, we
    // pre-emptively stop any existing runner so the new start always gets
    // a clean slot. Recovers from the "stuck-orchestrator" state observed
    // in smoke tour 2026-04-25 (map-reduce's spawn took >60s, the script's
    // curl gave up, but the server-side runner kept holding the slot,
    // cascading "A swarm is already running" to every subsequent preset).
    // Best-effort: stop errors are swallowed since the new start will
    // surface its own error if the orchestrator is truly broken.
    if (parsed.data.force === true) {
      try {
        await orch.stop();
      } catch {
        // ignore — proceed to start; if it fails it'll fail with a real reason
      }
    }
    // Phase 1 (#243): when the client posted a topology, derive the
    // legacy agentCount + per-role models from it. Topology wins over
    // any conflicting legacy fields the same payload happens to carry.
    // This single-source-of-truth shift lets the runner side stay
    // unchanged for now — it still consumes agentCount + plannerModel
    // etc., but those values came from the user's grid choices.
    const legacy = parsed.data.topology
      ? deriveLegacyFields(parsed.data.topology, parsed.data.preset)
      : null;
    const effAgentCount = legacy?.agentCount ?? parsed.data.agentCount;
    const effDedicatedAuditor = legacy?.dedicatedAuditor ?? parsed.data.dedicatedAuditor;
    const effPlannerModel = legacy?.plannerModel ?? parsed.data.plannerModel;
    const effWorkerModel = legacy?.workerModel ?? parsed.data.workerModel;
    const effAuditorModel = legacy?.auditorModel ?? parsed.data.auditorModel;
    // Task #109: map-reduce floor agentCount=4 (1 reducer + 3 mappers).
    // Smaller setups (agentCount=3 = 2 mappers) leave one mapper with a
    // trivially-small slice that the model collapses on; full RCA in
    // run 2bcf662f. The 2-mapper minimum is enforced inside the runner
    // anyway, but rejecting at the schema layer gives a clearer error.
    if (parsed.data.preset === "map-reduce" && effAgentCount < 4) {
      res.status(400).json({
        error: `Map-reduce requires at least 4 agents (1 reducer + 3 mappers). With fewer mappers, slice quality degrades sharply and one mapper typically gets stuck on a tiny slice. Got agentCount=${effAgentCount}.`,
      });
      return;
    }
    // Task #131: orchestrator-worker-deep needs at least 1 orchestrator
    // + 1 mid-lead + 2 workers = 4 agents to add coverage over flat OW.
    // Below that, the topology degenerates (mid-lead gets 0-1 workers
    // and the deep tier is just extra latency). Match map-reduce's
    // policy: reject at the route layer with a clear message.
    if (parsed.data.preset === "orchestrator-worker-deep" && effAgentCount < 4) {
      res.status(400).json({
        error: `orchestrator-worker-deep requires at least 4 agents (1 orchestrator + 1 mid-lead + 2 workers). With fewer, the deep tier degenerates into flat OW with extra latency. Got agentCount=${effAgentCount}.`,
      });
      return;
    }
    // Task #132: continuous mode safety. Without a budget cap, the
    // runner has no stop signal except user/error — that's an
    // infinite loop the user almost certainly didn't intend. Reject
    // here with a clear message rather than burning tokens.
    const continuousErr = validateContinuousMode({
      continuous: parsed.data.continuous,
      preset: parsed.data.preset,
      tokenBudget: parsed.data.tokenBudget,
      wallClockCapMs: parsed.data.wallClockCapMs,
    });
    if (continuousErr) {
      res.status(400).json({ error: continuousErr });
      return;
    }
    let localPath: string;
    try {
      // WSL ↔ Windows boundary normalization (see route preflight
      // handler comment for context).
      const parentPath = normalizeWslPath(parsed.data.parentPath);
      localPath = deriveCloneDir(parsed.data.repoUrl, parentPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
      return;
    }
    // R12 wiring (2026-05-04): pre-flight disk check at the parent
    // dir (the clone dir may not exist yet). Refuse if < 2 GB free —
    // a typical clone + run-state + summaries needs at least that
    // much breathing room. statfs unavailable → graceful pass-through.
    const diskParent = path.dirname(localPath);
    const diskCheck = await preflightDiskCheck({ targetPath: diskParent });
    if (!diskCheck.ok) {
      res.status(507).json({
        error: `Insufficient disk space at ${diskParent}: ${diskCheck.reason}`,
      });
      return;
    }
    try {
      // Task #132: continuous mode replaces rounds with an effectively-
      // unbounded value (1M). The runners see this same cfg.rounds in
      // their for-loop, but a budget cap is guaranteed to stop the run
      // long before round 1M. Avoids touching every runner's loop.
      const effectiveRounds = parsed.data.continuous
        ? 1_000_000
        : (parsed.data.rounds ?? 3);
      // R4 wiring (2026-05-04): pre-flight cost projector. When the
      // user has set maxCostUsd AND the projected spend already
      // exceeds it on Day 1, refuse rather than start a run that's
      // guaranteed to halt mid-way on cap:cost. Skipped for continuous
      // (effectiveRounds=1M) since the projection is meaningless
      // there — the maxCostUsd cap is the actual stop signal.
      if (
        parsed.data.maxCostUsd &&
        parsed.data.maxCostUsd > 0 &&
        !parsed.data.continuous
      ) {
        const projection = projectRunCost({
          model: parsed.data.model ?? config.DEFAULT_MODEL,
          totalTurns: effectiveRounds * effAgentCount,
        });
        if (
          exceedsBudget({
            projectedCostUsd: projection.projectedCostUsd,
            costCapUsd: parsed.data.maxCostUsd,
          })
        ) {
          res.status(400).json({
            error: `Projected run cost ($${projection.projectedCostUsd.toFixed(2)}) exceeds maxCostUsd ($${parsed.data.maxCostUsd.toFixed(2)}). Either raise maxCostUsd or shorten the run. ${projection.breakdown}`,
          });
          return;
        }
      }
      await orch.start({
        repoUrl: parsed.data.repoUrl,
        localPath,
        agentCount: effAgentCount,
        rounds: effectiveRounds,
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
        plannerModel: effPlannerModel,
        // Blackboard workers default to DEFAULT_WORKER_MODEL (gemma4) so
        // the planner's heavier reasoning model isn't burned on every
        // worker turn. Other presets share `model` across all agents.
        workerModel:
          effWorkerModel ??
          (parsed.data.preset === "blackboard"
            ? config.DEFAULT_WORKER_MODEL
            : undefined),
        wallClockCapMs: parsed.data.wallClockCapMs,
        // #296: pre-commit verify command. Threaded into the runner
        // so BlackboardRunner.executeWorkerTodoV2 can construct the
        // verify adapter when present. Other presets ignore.
        verifyCommand: parsed.data.verifyCommand,
        resumeContract: parsed.data.resumeContract,
        // Blackboard defaults dedicatedAuditor to ON (env-overridable
        // via DEFAULT_DEDICATED_AUDITOR). Explicit per-run value
        // always wins — including explicit `false` to disable.
        dedicatedAuditor:
          effDedicatedAuditor ??
          (parsed.data.preset === "blackboard"
            ? config.DEFAULT_DEDICATED_AUDITOR
            : undefined),
        // Blackboard auditor defaults to DEFAULT_AUDITOR_MODEL (nemotron)
        // when dedicatedAuditor is on AND no per-run override. Auditor
        // fires rarely so its latency is amortized; cross-criterion
        // synthesis benefits most from the strongest reasoning tier.
        auditorModel:
          effAuditorModel ??
          (parsed.data.preset === "blackboard" &&
          (effDedicatedAuditor ?? config.DEFAULT_DEDICATED_AUDITOR)
            ? config.DEFAULT_AUDITOR_MODEL
            : undefined),
        specializedWorkers: parsed.data.specializedWorkers,
        criticEnsemble: parsed.data.criticEnsemble,
        selfConsistencyK: parsed.data.selfConsistencyK,
        moaAggregatorCount: parsed.data.moaAggregatorCount,
        moaConvergenceThreshold: parsed.data.moaConvergenceThreshold,
        moaProposerModel: parsed.data.moaProposerModel,
        moaAggregatorModel: parsed.data.moaAggregatorModel,
        // T196 + T199 (2026-05-04): per-tier model arrays + extras
        // for the open-weights-parallelism value prop.
        moaProposerModels: parsed.data.moaProposerModels,
        moaAggregationLevels: parsed.data.moaAggregationLevels,
        orchestratorModel: parsed.data.orchestratorModel,
        midLeadModel: parsed.data.midLeadModel,
        dispositionModels: parsed.data.dispositionModels,
        importGraphSlicing: parsed.data.importGraphSlicing,
        crossClusterDiscovery: parsed.data.crossClusterDiscovery,
        streamingReducer: parsed.data.streamingReducer,
        dynamicRoles: parsed.data.dynamicRoles,
        parallelPropositions: parsed.data.parallelPropositions,
        twoStageMoA: parsed.data.twoStageMoA,
        bidirectionalRefinement: parsed.data.bidirectionalRefinement,
        baselineSelfCritique: parsed.data.baselineSelfCritique,
        baselineAttempts: parsed.data.baselineAttempts,
        testDrivenTodos: parsed.data.testDrivenTodos,
        parallelHypothesis: parsed.data.parallelHypothesis,
        chainTo: parsed.data.chainTo,
        adaptiveWorkers: parsed.data.adaptiveWorkers,
        executeNextAction: parsed.data.executeNextAction,
        tokenBudget: parsed.data.tokenBudget,
        maxCostUsd: parsed.data.maxCostUsd,
        // W13 wiring: per-run failover chain pass-through.
        providerFailover: parsed.data.providerFailover,
        autoGenerateGoals: parsed.data.autoGenerateGoals,
        autoStretchReflection: parsed.data.autoStretchReflection,
        verifier: parsed.data.verifier,
        useWorkerPipeline: parsed.data.useWorkerPipeline,
        plannerFallbackModel: parsed.data.plannerFallbackModel,
        continuous: parsed.data.continuous,
        autoMemory: parsed.data.autoMemory,
        autoDesignMemory: parsed.data.autoDesignMemory,
        // Phase 4a of #243: store the resolved topology on RunConfig so
        // summary.json can carry it. Synthesized from the legacy fields
        // when the client didn't post one — older clients still get a
        // populated topology, just one derived from preset+count.
        topology:
          parsed.data.topology ??
          synthesizeTopology(parsed.data.preset, effAgentCount, {
            dedicatedAuditor: effDedicatedAuditor,
            plannerModel: effPlannerModel,
            workerModel: effWorkerModel,
            auditorModel: effAuditorModel,
          }),
        postRoundCritique: parsed.data.postRoundCritique,
        postSynthesisCritique: parsed.data.postSynthesisCritique,
        workerDispositions: parsed.data.workerDispositions,
        debateAudit: parsed.data.debateAudit,
        debateAuditRounds: parsed.data.debateAuditRounds,
        councilMappers: parsed.data.councilMappers,
        councilMapperRounds: parsed.data.councilMapperRounds,
        pheromoneHotseed: parsed.data.pheromoneHotseed,
        pheromoneHotFiles: parsed.data.pheromoneHotFiles,
        pipeline: parsed.data.pipeline,
        rubricGrading: parsed.data.rubricGrading,
        checkpointing: parsed.data.checkpointing,
      });
      res.json({ ok: true, status: orch.status() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // R6 wiring (2026-05-04): when SWARM_DRAIN_ON_STOP is ON, the
  // first /stop click drains (finish current turn); a second click
  // within 5s hard-kills. Tracked at module scope per-process — a
  // single user clicking Stop twice is the canonical case. With the
  // flag OFF (default), every click hard-kills as before.
  r.post("/stop", async (_req: Request, res: Response) => {
    try {
      if (config.SWARM_DRAIN_ON_STOP) {
        const decision = decideStopAction({
          now: Date.now(),
          lastStopAt: lastStopClickAt,
        });
        lastStopClickAt = Date.now();
        if (decision.action === "drain") {
          await orch.drain();
          res.json({ ok: true, action: "drain", reason: decision.reason });
          return;
        }
      }
      await orch.stop();
      res.json({ ok: true, action: "kill" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // #299: mid-run directive amend. The user submits an addendum
  // (typically when the conformance gauge drops) and the orchestrator
  // appends it to the active run's amendments buffer. Each runner
  // reads via opts.getAmendments(runId) on its next prompt cycle —
  // the nudge takes effect at the next turn boundary, not instantly.
  // Returns 404 when no run is active or the runId doesn't match.
  const AmendBody = z.object({
    runId: z.string().min(1).max(40),
    text: z.string().trim().min(1).max(1000),
  });
  r.post("/amend", async (req: Request, res: Response) => {
    const parsed = AmendBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const stored = orch.addAmendment(parsed.data.runId, parsed.data.text);
    if (!stored) {
      res.status(404).json({ error: "No active run with that runId, or text was empty" });
      return;
    }
    // Broadcast happens inside orch.addAmendment via opts.emit so
    // all WS clients see the directive_amended event in realtime.
    res.json({ ok: true, amendment: stored });
  });

  // Task #167: soft-stop. Workers finish currently-claimed todos
  // (no in-flight commits get lost), no new claims, then escalate
  // to hard stop. Backstopped at 3 min — user can press hard /stop
  // to escalate immediately. For non-blackboard presets, falls
  // through to hard /stop (orchestrator handles the dispatch).
  r.post("/drain", async (_req: Request, res: Response) => {
    try {
      await orch.drain();
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
    orch.injectUser(parsed.data.text, {
      intent: parsed.data.intent ?? "steer",
      ...(parsed.data.targetAgent ? { targetAgent: parsed.data.targetAgent } : {}),
    });
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
  r.get("/runs", async (req: Request, res: Response) => {
    const status = orch.status();
    // 2026-04-24: when idle (no active run, status.localPath
    // undefined), fall back to the orchestrator's cached
    // lastParentPath so the dropdown stays useful between runs.
    // Without this fallback the dropdown was empty whenever the user
    // wasn't mid-run — which is most of the time.
    const activeParent = status.localPath
      ? path.dirname(path.resolve(status.localPath))
      : orch.getLastParentPath();
    // #238 (2026-04-28): when ?includeOtherParents=true, also scan
    // every parent path the orchestrator has tracked. Lets the UI
    // show prior runs even when the active parent is fresh (per the
    // option-C UX: clone-scoped first + a footer link surfacing the
    // global view).
    const includeOtherParents =
      typeof req.query.includeOtherParents === "string" &&
      req.query.includeOtherParents.toLowerCase() === "true";
    const parentsToScan = new Set<string>();
    if (activeParent) parentsToScan.add(activeParent);
    if (includeOtherParents) {
      for (const p of orch.getKnownParentPaths()) parentsToScan.add(p);
    }
    if (parentsToScan.size === 0) {
      res.json({ runs: [], parents: [] });
      return;
    }
    const activeClone = status.localPath ? path.resolve(status.localPath) : null;
    const activeRunId = status.runConfig?.preset
      ? status.runId ?? null
      : null;
    const runs: RunSummaryDigest[] = [];
    const parentsScanned: string[] = [];
    for (const parent of parentsToScan) {
      let entries: string[];
      try {
        entries = await fs.readdir(parent);
      } catch {
        continue;
      }
      parentsScanned.push(parent);
      for (const name of entries) {
        const cloneDir = path.join(parent, name);
        let stat: import("node:fs").Stats;
        try {
          stat = await fs.stat(cloneDir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        // 2026-04-24: surface EVERY per-run summary (summary-<iso>.json),
        // not just the latest. A target run 8 times now contributes 8
        // dropdown rows instead of 1.
        const digests = await readAllRunDigests(cloneDir, name);
        for (const d of digests) {
          // Active = the run whose clonePath matches AND whose runId
          // matches the orchestrator's current runId. Without the runId
          // check, every prior run on the active target's clone dir
          // would falsely flag as "active".
          d.isActive = activeClone !== null && cloneDir === activeClone && d.runId !== undefined && d.runId === activeRunId;
          // #238: tag each digest with its parent so the UI can group
          // by parent in the cross-parent view.
          (d as RunSummaryDigest & { parentPath?: string }).parentPath = parent;
          runs.push(d);
        }
      }
    }
    // Newest first by startedAt (descending). Falls back to dir name
    // when startedAt is missing (shouldn't happen with a real
    // summary, but defensive).
    runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    res.json({ runs, parents: parentsScanned });
  });

  // Single full-summary fetch for the history modal (2026-04-24).
  // Lookup by clonePath + runId — the modal already knows both from
  // its digest, so we don't need to scan everything again.
  // Returns the entire summary.json contents (RunSummary shape +
  // contract / agent stats), not a thin digest.
  //
  // Defensive on bad inputs: 400 on missing params, 404 if the
  // matching summary file doesn't exist or doesn't carry the
  // requested runId, 500 on unexpected I/O.
  r.get("/run-summary", async (req: Request, res: Response) => {
    const clonePath = typeof req.query.clonePath === "string" ? req.query.clonePath : "";
    const runId = typeof req.query.runId === "string" ? req.query.runId : "";
    if (!clonePath) {
      res.status(400).json({ error: "clonePath required" });
      return;
    }
    let entries: string[];
    try {
      entries = await fs.readdir(clonePath);
    } catch {
      res.status(404).json({ error: "clonePath not readable" });
      return;
    }
    // Try per-run files first (canonical), then summary.json fallback.
    const candidates = [
      ...entries.filter((e) => /^summary-.+\.json$/.test(e)),
      "summary.json",
    ];
    for (const e of candidates) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(clonePath, e), "utf8");
      } catch {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        const tmp = JSON.parse(raw);
        if (typeof tmp !== "object" || tmp === null) continue;
        parsed = tmp as Record<string, unknown>;
      } catch {
        continue;
      }
      // If runId requested, only return the matching summary. If not
      // requested, return the first parseable (typically the latest).
      if (runId && parsed.runId !== runId) continue;
      res.json(parsed);
      return;
    }
    res.status(404).json({ error: "no matching summary found" });
  });

  // Task #152: read .swarm-memory.jsonl for a clone. Returns the parsed
  // entries (newest first by ts), or [] if missing. Cheap — file is
  // capped at 1 MB by memoryStore's prune logic. Used by the UI memory-
  // log sidebar to surface lessons learned across prior runs.
  r.get("/memory", async (req: Request, res: Response) => {
    const clonePath = typeof req.query.clonePath === "string" ? req.query.clonePath : "";
    if (!clonePath) {
      res.status(400).json({ error: "clonePath required" });
      return;
    }
    // #240 (2026-04-28): when ?includeOtherParents=true, also aggregate
    // memory entries from clones in OTHER known parent paths. Each
    // entry gets tagged with its source clone so the UI can group.
    const includeOtherParents =
      typeof req.query.includeOtherParents === "string" &&
      req.query.includeOtherParents.toLowerCase() === "true";
    const clonesToScan: string[] = [clonePath];
    const otherClones: string[] = [];
    if (includeOtherParents) {
      const cloneName = path.basename(clonePath);
      const activeParent = path.dirname(path.resolve(clonePath));
      for (const parent of orch.getKnownParentPaths()) {
        if (parent === activeParent) continue;
        // Look for the same target clone name under each other parent.
        const candidate = path.join(parent, cloneName);
        try {
          const stat = await fs.stat(candidate);
          if (stat.isDirectory()) {
            clonesToScan.push(candidate);
            otherClones.push(candidate);
          }
        } catch {
          // skip parent dirs that don't have this clone
        }
      }
    }
    const entries: Array<Record<string, unknown> & { _sourceClone?: string }> = [];
    let primaryEntries = 0;
    let otherParentEntries = 0;
    for (const dir of clonesToScan) {
      const memPath = path.join(dir, ".swarm-memory.jsonl");
      let raw: string;
      try {
        raw = await fs.readFile(memPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        // Other read errors on a SECONDARY clone shouldn't fail the
        // whole request — primary clone errors propagate as before.
        if (dir !== clonePath) continue;
        res.status(500).json({ error: (err as Error).message });
        return;
      }
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj && typeof obj === "object") {
            entries.push({ ...obj, _sourceClone: dir });
            if (dir === clonePath) primaryEntries++;
            else otherParentEntries++;
          }
        } catch {
          // skip malformed lines silently — same policy as memoryStore.readMemory
        }
      }
    }
    entries.sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0));
    // #240: surface counts so the UI can render "5 entries from this
    // clone + 12 from 3 other clones" without re-counting client-side.
    res.json({
      entries,
      ...(includeOtherParents
        ? { primaryEntries, otherParentEntries, otherClones }
        : {}),
    });
  });

  // Direction 1 Phase 2: outcome history + preset recommendation.
  r.get("/outcome/stats", async (req: Request, res: Response) => {
    const clonePath = typeof req.query.clonePath === "string" ? req.query.clonePath : "";
    if (!clonePath) {
      res.status(400).json({ error: "clonePath required" });
      return;
    }
    const { readOutcomeHistory: readHistory, computeStats: computeOutcomeStats } = await import("../swarm/outcomeHistory.js");
    const outcomes = await readHistory(clonePath);
    const stats = computeOutcomeStats(outcomes);
    const result: Record<string, unknown> = {};
    for (const [preset, stat] of stats) {
      result[preset] = stat;
    }
    res.json({ outcomes: outcomes.length, stats: result });
  });

  r.get("/outcome/recommend", async (req: Request, res: Response) => {
    const directive = typeof req.query.directive === "string" ? req.query.directive : "";
    const clonePath = typeof req.query.clonePath === "string" ? req.query.clonePath : "";
    if (!directive) {
      res.status(400).json({ error: "directive required" });
      return;
    }
    const { recommendPreset: recommend, readOutcomeHistory: readHistory } = await import("../swarm/outcomeHistory.js");
    const { suggestAdaptiveParams } = await import("../swarm/adaptiveParams.js");
    const outcomes = clonePath ? await readHistory(clonePath) : [];
    const recommendation = recommend(directive, outcomes);
    const adaptive = suggestAdaptiveParams(recommendation.preset as import("../swarm/SwarmRunner.js").PresetId, outcomes);
    res.json({ ...recommendation, adaptiveParams: adaptive });
  });

  // Direction 6: checkpoint listing + read.
  r.get("/checkpoints/:runId", async (req: Request, res: Response) => {
    const runId = typeof req.params.runId === "string" ? req.params.runId : String(req.params.runId);
    const clonePath = typeof req.query.clonePath === "string" ? req.query.clonePath : "";
    if (!clonePath) {
      res.status(400).json({ error: "clonePath query parameter required" });
      return;
    }
    const { listCheckpoints } = await import("../swarm/checkpoint.js");
    const checkpoints = await listCheckpoints(clonePath, runId);
    res.json({ runId, checkpoints });
  });

  r.get("/checkpoints/:runId/:fileName", async (req: Request, res: Response) => {
    const runId = typeof req.params.runId === "string" ? req.params.runId : String(req.params.runId);
    const fileName = typeof req.params.fileName === "string" ? req.params.fileName : String(req.params.fileName);
    const clonePath = typeof req.query.clonePath === "string" ? req.query.clonePath : "";
    if (!clonePath) {
      res.status(400).json({ error: "clonePath query parameter required" });
      return;
    }
    const { readCheckpoint } = await import("../swarm/checkpoint.js");
    const checkpoint = await readCheckpoint(clonePath, runId, fileName);
    if (!checkpoint) {
      res.status(404).json({ error: "Checkpoint not found" });
      return;
    }
    res.json(checkpoint);
  });

  // Direction 6 Phase 2: event timeline.
  r.get("/timeline/:runId", async (req: Request, res: Response) => {
    const runId = typeof req.params.runId === "string" ? req.params.runId : String(req.params.runId);
    const clonePath = typeof req.query.clonePath === "string" ? req.query.clonePath : "";
    if (!clonePath) {
      res.status(400).json({ error: "clonePath query parameter required" });
      return;
    }
    const { getTimeline } = await import("../swarm/timeline.js");
    const timeline = await getTimeline(clonePath, runId);
    if (!timeline) {
      res.status(404).json({ error: "No event log found for this run" });
      return;
    }
    res.json(timeline);
  });

  // Direction 5: persistent memory store CRUD.
  r.get("/memory-store", async (req: Request, res: Response) => {
    const clonePath = typeof req.query.clonePath === "string" ? req.query.clonePath : "";
    if (!clonePath) {
      res.status(400).json({ error: "clonePath required" });
      return;
    }
    const { loadMemoryStore } = await import("../memory/MemoryStore.js");
    const store = await loadMemoryStore(clonePath);
    res.json({ entries: store.snapshot() });
  });

  r.post("/memory-store", async (req: Request, res: Response) => {
    const { key, value, tags, clonePath } = req.body as { key?: string; value?: string; tags?: string[]; clonePath?: string };
    if (!key || !value || !clonePath) {
      res.status(400).json({ error: "key, value, and clonePath required" });
      return;
    }
    const { loadMemoryStore } = await import("../memory/MemoryStore.js");
    const store = await loadMemoryStore(clonePath);
    store.store(key, value, tags, "user");
    await store.flush();
    res.json({ ok: true, key });
  });

  r.delete("/memory-store/:key", async (req: Request, res: Response) => {
    const key = typeof req.params.key === "string" ? req.params.key : String(req.params.key);
    const clonePath = typeof req.query.clonePath === "string" ? req.query.clonePath : "";
    if (!clonePath) {
      res.status(400).json({ error: "clonePath required" });
      return;
    }
    const { loadMemoryStore } = await import("../memory/MemoryStore.js");
    const store = await loadMemoryStore(clonePath);
    const deleted = store.forget(key);
    await store.flush();
    res.json({ ok: true, deleted });
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
  // Phase 4a of #243: topology surfaced in the dropdown row so users
  // can scan agent specs at a glance. Optional — older summaries
  // don't have it, in which case the row shows "—".
  topology?: import("../../../shared/src/topology.js").Topology;
}

function parseSummaryToDigest(
  raw: string,
  cloneDir: string,
  name: string,
): RunSummaryDigest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.preset !== "string" || typeof obj.startedAt !== "number") return null;
  const contract = obj.contract as Record<string, unknown> | undefined;
  // Phase 4a of #243: parse topology from summary.json if present.
  // Permissive — a malformed topology doesn't fail the digest, just
  // skips the field. The schema would catch it if we re-validated,
  // but since the dropdown can fall back to "—" we just trust it.
  const topology =
    obj.topology &&
    typeof obj.topology === "object" &&
    Array.isArray((obj.topology as { agents?: unknown }).agents)
      ? (obj.topology as RunSummaryDigest["topology"])
      : undefined;
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
    topology,
  };
}

// 2026-04-24: returns one digest per RUN in this cloneDir, not just
// per cloneDir. Reads every `summary-<iso>.json` (per-run, never
// overwritten — Unit 49) and falls back to bare `summary.json`
// (latest pointer) only when no per-run file exists. Dedups by
// (runId || startedAt) so a legacy clone whose latest pointer
// happens to match a per-run file isn't counted twice.
//
// Previously the route only returned ONE digest per cloneDir (the
// latest), so a target run 8 times appeared as a single dropdown
// row with the most recent stats. Surfacing all per-run summaries
// gives the user true historical visibility into the framework's
// behavior across multiple iterations on the same target.
async function readAllRunDigests(
  cloneDir: string,
  name: string,
): Promise<RunSummaryDigest[]> {
  const digests: RunSummaryDigest[] = [];
  const seen = new Set<string>();
  const dedupKey = (d: RunSummaryDigest) => d.runId ?? `t:${d.startedAt}`;

  // Per-run files first — these are the source of truth, written once
  // at run-end and never touched again.
  let perRun: string[] = [];
  try {
    const all = await fs.readdir(cloneDir);
    perRun = all.filter((e) => /^summary-.+\.json$/.test(e));
  } catch {
    // unreadable cloneDir — return empty
    return [];
  }
  for (const e of perRun) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(cloneDir, e), "utf8");
    } catch {
      continue;
    }
    const d = parseSummaryToDigest(raw, cloneDir, name);
    if (!d) continue;
    const k = dedupKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    digests.push(d);
  }

  // Fallback: bare summary.json (the latest pointer). On modern
  // clones this duplicates one of the per-run files above and the
  // dedup catches it. On legacy clones with no per-run files, this
  // is the only way to see the run at all.
  let latestRaw: string | null = null;
  try {
    latestRaw = await fs.readFile(path.join(cloneDir, "summary.json"), "utf8");
  } catch {
    // no latest pointer — fine
  }
  if (latestRaw !== null) {
    const d = parseSummaryToDigest(latestRaw, cloneDir, name);
    if (d) {
      const k = dedupKey(d);
      if (!seen.has(k)) {
        seen.add(k);
        digests.push(d);
      }
    }
  }

  return digests;
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
