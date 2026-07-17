/**
 * Brain + maintenance routes (extracted from swarm.ts).
 * Register via registerBrainRoutes(r, orch) from swarmRouter.
 */

import path from "node:path";
import { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { BRAIN_ALIAS_USER_NOTE } from "@ollama-swarm/shared/brainAlias";
import { tokenTracker } from "../services/ollamaProxy.js";
import {
  validate,
  BrainApplyBody,
  BrainRejectBody,
  BrainProvisionBody,
  MaintenancePruneBody,
} from "./schemas.js";
import {
  getMaintenanceStatus,
  runMaintenancePrune,
  type PruneTarget,
} from "../services/maintenancePrune.js";
import { assertAllowedClonePath } from "./clonePathGuard.js";
import type { Orchestrator } from "../services/Orchestrator.js";
import { pickProvider } from "../providers/pickProvider.js";
import { BRAIN_CONTROL_SURFACE } from "../swarm/brainControlSurface.js";
import { buildPresetGuideString, buildOptionsTable } from "../swarm/presetGuide.js";
import { extractLabeledJson } from "../../../shared/src/extractJson.js";

/** If path is .../logs or .../logs/<runId>, return the project clone root. */
function resolveProjectRootFromPath(resolved: string): string {
  const base = path.basename(resolved);
  const parent = path.dirname(resolved);
  if (base === "logs") return parent;
  if (path.basename(parent) === "logs") return path.dirname(parent);
  return resolved;
}

/** Active run ids — never delete their project log dirs mid-run. */
function collectActiveRunProtectNames(orch: Orchestrator): string[] {
  const names = new Set<string>();
  try {
    for (const run of orch.listActiveRuns()) {
      if (run.runId) {
        names.add(run.runId);
        names.add(run.runId.slice(0, 8));
      }
    }
  } catch {
    /* ignore */
  }
  return [...names];
}

function guardClonePath(
  orch: Orchestrator,
  res: Response,
  clonePath: string,
): string | null {
  const guard = assertAllowedClonePath(orch, clonePath);
  if (!guard.ok) {
    res.status(guard.status).json({ error: guard.error });
    return null;
  }
  return guard.resolved;
}

export function registerBrainRoutes(r: Router, orch: Orchestrator) {
  // P7: Brain health endpoint
  // Machine-readable API map for Brain-OS agents (start / during / after).
  r.get("/brain/control-surface", (_req: Request, res: Response) => {
    res.json(BRAIN_CONTROL_SURFACE);
  });

  // Maintenance: app + project (clone) log retention (Brain + UI + CLI).
  r.get("/maintenance/status", (req: Request, res: Response) => {
    const clonePathRaw =
      typeof req.query.clonePath === "string" ? req.query.clonePath.trim() : "";
    let projectRoot: string | undefined;
    if (clonePathRaw) {
      const guard = assertAllowedClonePath(orch, clonePathRaw);
      if (!guard.ok) {
        res.status(guard.status).json({ error: guard.error });
        return;
      }
      // If client pointed at logs/ or logs/<runId>, use clone root.
      projectRoot = resolveProjectRootFromPath(guard.resolved);
    }
    res.json(getMaintenanceStatus(process.cwd(), projectRoot));
  });

  r.post(
    "/maintenance/prune",
    validate(MaintenancePruneBody, "body"),
    (req: Request, res: Response) => {
      const body = req.body as z.infer<typeof MaintenancePruneBody>;
      const target = body.target as PruneTarget;
      let root = process.cwd();
      const protectNames = collectActiveRunProtectNames(orch);

      if (target === "project-logs") {
        if (!body.clonePath?.trim()) {
          res.status(400).json({ error: "clonePath is required when target is project-logs" });
          return;
        }
        const guard = assertAllowedClonePath(orch, body.clonePath.trim());
        if (!guard.ok) {
          res.status(guard.status).json({ error: guard.error });
          return;
        }
        root = resolveProjectRootFromPath(guard.resolved);
      }

      const result = runMaintenancePrune({
        root,
        target,
        mode: body.mode === "purge" ? "purge" : "prune",
        apply: body.apply === true,
        keepDays: body.keepDays,
        maxKeep: body.maxKeep,
        keepNArchives: body.keepNArchives,
        protectNames,
      });
      res.json(result);
    },
  );

  r.get("/brain/health", async (_req: Request, res: Response) => {
    await orch.whenBrainReady();
    const brainService = orch.getBrainService();
    if (!brainService) {
      res.json({ status: "not-initialized" });
      return;
    }
    const health = brainService.getBrainHealth();
    res.json({
      ...health,
      proxyPressure: (tokenTracker as any).pressure ? (tokenTracker as any).pressure() : null,
    });
  });

  // P7: Brain activity timeline
  r.get("/brain/activity", (_req: Request, res: Response) => {
    const brainService = orch.getBrainService();
    if (!brainService) {
      res.json({ activities: [] });
      return;
    }
    res.json({ activities: brainService.getRecentActivities() });
  });

  // P7: Brain run insights / analyses (formerly "proposals")
  r.get("/brain/proposals", async (_req: Request, res: Response) => {
    const brainService = orch.getBrainService();
    if (!brainService) {
      res.json({ proposals: [] });
      return;
    }
    const proposals = await brainService.getAllProposals();
    res.json({ proposals });
  });

  // P7: Apply brain proposal — SYSTEM PATCHING DISABLED.
  // Brain now serves as librarian/master-admin for run analysis only.
  r.post("/brain/apply", validate(BrainApplyBody, "body"), async (_req: Request, res: Response) => {
    res.status(410).json({
      success: false,
      error: "System patching has been removed. Brain now provides run analysis and librarian functions only (initialize/start/finish/review/analyze runs).",
    });
  });

  // Phase 7: Approve & start a follow-up run from a brain insight (provisioner).
  r.post("/brain/provision", validate(BrainProvisionBody, "body"), async (req: Request, res: Response) => {
    await orch.whenBrainReady();
    const brainService = orch.getBrainService();
    if (!brainService) {
      res.status(500).json({ error: "Brain service not initialized" });
      return;
    }
    const body = req.body as z.infer<typeof BrainProvisionBody>;
    const guarded = guardClonePath(orch, res, body.clonePath);
    if (!guarded) return;

    let title = body.title?.trim();
    let description = body.description?.trim() ?? "";
    let category = body.category;
    let priority = body.priority ?? "medium";
    let proposalId = body.proposalId;

    if (body.proposalId) {
      const all = await brainService.getAllProposals(guarded);
      const found = all.find((p) => p.id === body.proposalId);
      if (found) {
        title = title || found.title;
        description = description || found.description;
        category = category ?? found.category;
        priority = found.priority ?? priority;
        proposalId = found.id;
      }
    }
    if (!title) {
      res.status(400).json({ error: "title or known proposalId required" });
      return;
    }

    const insight = {
      id: proposalId,
      title,
      description,
      category: category ?? "followup",
      priority,
    };
    try {
      const runId = await brainService.getProvisioner().startRunForProposal(insight, guarded, {
        approved: true,
      });
      if (!runId) {
        res.status(409).json({
          success: false,
          error:
            "Could not start run (capacity, config, or approve-to-provision gate). Check server logs.",
        });
        return;
      }
      res.json({
        success: true,
        runId,
        navigateTo: `/runs/${encodeURIComponent(runId)}`,
        proposalId: proposalId ?? null,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // P7: Reject brain proposal
  r.post("/brain/reject", validate(BrainRejectBody, "body"), async (req: Request, res: Response) => {
    await orch.whenBrainReady();
    const brainService = orch.getBrainService();
    if (!brainService) {
      res.status(500).json({ error: "Brain service not initialized" });
      return;
    }
    const { proposalId, reason, clonePath } = req.body as z.infer<typeof BrainRejectBody>;
    let resolvedClone: string | undefined;
    if (clonePath) {
      const guarded = guardClonePath(orch, res, clonePath);
      if (!guarded) return;
      resolvedClone = guarded;
    }
    const result = await brainService.rejectProposal(proposalId, reason, resolvedClone);
    if (!result.success) {
      const status = result.error === "Proposal not found" ? 404 : 400;
      res.status(status).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, message: "Proposal rejected" });
  });

  // Persist brain chat history to disk (alongside run summary via snapshot)
  r.post("/brain/chat-history", (req: Request, res: Response) => {
    const { runId, history } = req.body || {};
    if (runId && Array.isArray(history)) {
      (orch as any).setBrainChatHistory?.(runId, history);
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: "runId and history array required" });
    }
  });

  // Real /brain/suggest route that calls injectSuggestion for proactive Brain suggestions
  r.post("/brain/suggest", async (req: Request, res: Response) => {
    await orch.whenBrainReady();
    const brainService = orch.getBrainService();
    if (!brainService) {
      return res.status(500).json({ error: "Brain service not initialized" });
    }
    const { runId, title, text, category } = req.body || {};
    if (!runId || !title || !text) {
      return res.status(400).json({ error: "runId, title, and text are required" });
    }
    if (brainService.injectSuggestion) {
      brainService.injectSuggestion(runId, { title, text, category });
      res.json({ success: true, message: "Suggestion injected" });
    } else {
      res.status(501).json({ error: "injectSuggestion not available" });
    }
  });

  // Brain chat: conversational interface to configure and start swarms.
  // The Brain (librarian/master-admin) helps via natural language.
  // Structured RECOMMENDATION + CONFIG blocks are inferred from the latest user
  // message (setup vs during-run). ?structured=true still forces it for API callers.
  r.post("/brain/chat", async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const { messages = [], runContext, clonePath, structured, model: clientModel } = body;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages array required" });
      }

      const lastUserMsg =
        [...messages].reverse().find((m: { role?: string }) => m.role === "user")?.content ??
        messages[messages.length - 1]?.content ??
        "";
      const { inferStructuredBrainMode } = await import("../swarm/brainChatMode.js");
      const wantsStructured =
        structured === true ||
        req.query.structured === "true" ||
        req.query.explain === "options" ||
        inferStructuredBrainMode(String(lastUserMsg ?? ""), { duringRun: !!runContext });

      // Ground recommendations using the real preset recommender (outcome history + seeds + heuristics).
      // Proactively quote real numbers from /outcome/stats when possible.
      let recommenderHint = "";
      try {
        const { recommendPreset, readOutcomeHistory, computeStats } = await import("../swarm/outcomeHistory.js");
        let outcomes: any[] = [];
        if (clonePath) {
          const resolved = guardClonePath(orch, res, clonePath);
          if (resolved) outcomes = await readOutcomeHistory(resolved).catch(() => []);
        }
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user")?.content || messages[messages.length-1]?.content || "";
        if (lastUserMsg && lastUserMsg.length > 5) {
          const rec = recommendPreset(lastUserMsg, outcomes);
          let statsLine = "";
          if (outcomes.length >= 3) {
            const stats = computeStats(outcomes);
            const s = stats.get(rec.preset as any);
            if (s) {
              statsLine = `\nReal performance: ${rec.preset} has median score ${(s.medianScore * 10).toFixed(1)}/10 (avg ${(s.avgScore * 10).toFixed(1)}/10) over ${s.sampleSize} similar runs.`;
            }
          }
          recommenderHint = `\n\nSYSTEM RECOMMENDER SUGGESTION (incorporate this for accuracy):\n- Best preset: ${rec.preset}\n- Rationale: ${rec.rationale}${statsLine}\n- Suggested: agentCount=${rec.agentCount}, rounds=${rec.rounds}, confidence=${rec.confidence.toFixed(2)} (source: ${rec.source})\n\nYou may use or refine this after reading the user's full description. Always provide your own supporting analysis referencing the user's words and any numbers above.`;

          // Support "explain all options" mode
          if (/explain all|all options|compare (all|options|presets)|show me the options/i.test(lastUserMsg)) {
            const table = buildOptionsTable(lastUserMsg);
            recommenderHint += `\n\nOPTIONS TABLE FOR THIS GOAL:\n${table}\n\nPresent the top 3 matches with a short table in your reply.`;
          }
        }
      } catch (e) {
        // recommender optional; prompt guide is still excellent
      }

      // Use shared module for the preset decision guide (avoids duplication).
      // The guide is built from docs/swarm-patterns.md and STATUS.md tables.
      const presetGuide = buildPresetGuideString();

      let systemPrompt = `You are Brain, the master-admin and librarian for ollama_swarm.
${BRAIN_ALIAS_USER_NOTE}

Your job is to help the user configure and START a swarm run using natural language. The user may be using the web UI **or** talking to you from a terminal / agent loop that can execute commands.

${presetGuide}
${recommenderHint}

Key rules:
- For local folders without a Git repo: use "parentPath" + "repoUrl": "".
- Default: model "deepseek-v4-flash:cloud", agentCount 5. For research-heavy tasks prefer enabling webTools + plannerTools.
- When user describes their *goal or use-case* (e.g. "I need to analyze many papers and find common patterns", "add OAuth and session handling to my API", "debate pros and cons of migrating", "explore this repo and understand its structure"), analyze it against the guide above and recommend the SINGLE best preset.

CRITICAL: When the user does not know which "swarm mode" / preset to pick:
- Clearly state: "Recommended Preset: council (or blackboard, map-reduce, etc.)"
- Give a short supporting analysis: "Because your goal sounds like X (quote user), and council excels at Y while map-reduce is better for Z."
- Suggest the matching UI filter if relevant: e.g. "Try the Research filter in the Swarm Mode card — it will highlight council + map-reduce + moa."
- Then output the full config JSON (including any webTools: true, etc. that fit the analysis).

When the user gives enough details, output the config **and** a ready-to-run command:

\`\`\`json
{
  "parentPath": "C:\\Users\\you\\workspace\\my-project",
  "repoUrl": "",
  "userDirective": "the full directive here",
  "preset": "blackboard",
  "agentCount": 5,
  "rounds": 0,
  "model": "deepseek-v4-flash:cloud",
  "webTools": true
}
\`\`\`

Then say:

"Ready to start this swarm?  
Run this in your terminal:

\`\`\`bash
ollama-swarm start --config swarm_config.json
\`\`\`

(You can also paste flags directly: ollama-swarm start --parent-path \"...\" --directive \"...\")"

CRITICAL BEHAVIOR:
- When the user says "yes", "start", "go", "launch", "do it", etc., re-emit the JSON block + tell them to run the \`ollama-swarm start\` command (or if they are in the web UI, the UI can auto-start).
- The real CLI is now \`ollama-swarm\` (provided by this project). It talks to the running server.
- Never invent fake commands.
- Be concise and actionable.
- Always ground your preset recommendation in the user's described use-case + the guide above. Provide supporting analysis.

MAINTENANCE (disk / logs cleanup):
You can clean **two** places:
1. **App** ollama_swarm logs/runs under the server cwd (\`npm run prune-logs\` / prune-runs).
2. **Project** target-repo logs at \`<clonePath>/logs/\` — where this app stores per-run summaries (\`summary-*.json\`) and run dirs. These often grow large on the user's project.

When the user asks to prune/purge **project** / **target** / **clone** / **repo** run logs:
MAINTENANCE: { "action": "prune", "target": "project-logs", "clonePath": "<absolute path>", "mode": "prune", "apply": false }
For aggressive cleanup of project logs (keep none except active runs):
MAINTENANCE: { "action": "purge", "target": "project-logs", "clonePath": "<absolute path>", "mode": "purge", "apply": false }
Use the clonePath from run context or the path the user provides. Always dry-run first unless they already confirmed.
When they say "yes" / "apply" / "delete" / "do it", re-emit with apply: true.

App-level (server machine logs, not the project repo):
MAINTENANCE: { "action": "prune", "target": "logs", "apply": false }
Targets: "logs" | "runs" | "all" (app) | "project-logs" (requires clonePath).
Modes: "prune" (retention) | "purge" (delete all unprotected).
CLI: \`ollama-swarm prune-logs --target project-logs --clone-path "..."\` / \`--mode purge --apply\`.`;

      const { resolveSystemLayerModel } = await import("../services/systemLayerSettings.js");
      let modelStr = resolveSystemLayerModel(
        typeof clientModel === "string" ? clientModel : undefined,
      ).modelString;
      let brainTools: typeof import("../swarm/brainDuringRun.js").BRAIN_EXPLORE_TOOLS | undefined;
      let brainDispatcher: import("../swarm/brainDuringRun.js").BrainExplorerDispatcher | undefined;
      let brainRunId: string | undefined;

      if (runContext && typeof runContext === "object") {
        const {
          enrichBrainRunContext,
          buildDuringRunSystemPrompt,
          BRAIN_EXPLORE_TOOLS,
          BrainExplorerDispatcher,
        } = await import("../swarm/brainDuringRun.js");
        const enriched = enrichBrainRunContext(
          orch,
          runContext,
          typeof clientModel === "string" ? clientModel : undefined,
        );
        if (enriched) {
          systemPrompt = buildDuringRunSystemPrompt(enriched.markdown, enriched.toolsEnabled);
          modelStr = enriched.modelString;
          brainRunId = enriched.runId;
          if (enriched.toolsEnabled && enriched.clonePath) {
            brainTools = BRAIN_EXPLORE_TOOLS;
            brainDispatcher = new BrainExplorerDispatcher(enriched.clonePath);
          }
        } else {
          systemPrompt += `

You are now in DURING-RUN assistance mode for an active swarm.

Current run context (use this to give real-time help, suggestions, analysis, or draft amendments):
${JSON.stringify(runContext, null, 2)}

Focus on helping the user understand the current state. Format replies in Markdown.`;
        }
      }

      const { provider, modelId } = pickProvider(modelStr);

      // For structured mode, instruct LLM to output parseable sections
      const duringRun = !!runContext?.runId;
      if (wantsStructured) {
        if (duringRun) {
          systemPrompt += `\n\nSTRUCTURED OUTPUT MODE (active run): After your normal reply, also output when relevant:
RECONFIG: { "extendWallClockCapMin": 15 } OR { "extendRounds": 2 } OR { "extendTokenBudget": 500000 }
Run limits use extend-only fields — never lower rounds/cap/budget.
When agents show long reasoning / pure-think thrash, suggest model failover or lower explore tool budget — not a referee (retired; deterministic stream-triage handles hard think aborts).
Omit RECONFIG if not needed.
You may also output: amend: one-line directive addendum (plain text, not JSON).`;
        } else {
          systemPrompt += `\n\nSTRUCTURED OUTPUT MODE: After your normal reply, also output exactly:
RECOMMENDATION: { "preset": "...", "confidence": 0.8, "rationale": "..." }
CONFIG: { the json config }
Use the tables and recommender data.`;
        }
      }

      const chatMessages = [
        { role: "system" as const, content: systemPrompt },
        ...messages.map((m: any) => ({
          role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
          content: String(m.content || ""),
        })),
      ];

      const t0Brain = Date.now();
      const result = await provider.chat({
        model: modelId,
        messages: chatMessages,
        signal: AbortSignal.timeout(90_000),
        ...(brainTools && brainDispatcher
          ? {
              tools: [...brainTools],
              dispatcher: brainDispatcher as unknown as import("../tools/ToolDispatcher.js").ToolDispatcher,
              maxToolTurns: 8,
              runId: brainRunId,
              brainInitiated: true,
            }
          : {}),
      });
      const { recordChatUsage } = await import("../services/ollamaProxy.js");
      recordChatUsage({
        promptTokens: result.usage?.promptTokens,
        responseTokens: result.usage?.responseTokens,
        promptText: chatMessages.map((m) => m.content).join("\n"),
        responseText: result.text,
        durationMs: Date.now() - t0Brain,
        model: modelId,
        path: `/brain-chat (${provider.id})`,
        runId: brainRunId,
      });

      let text = result.text;
      const maintenanceRaw = extractLabeledJson(text, "MAINTENANCE") as {
        action?: string;
        target?: string;
        apply?: boolean;
        mode?: string;
        clonePath?: string;
        keepDays?: number;
        maxKeep?: number;
        keepNArchives?: number;
      } | null;
      let maintenanceResult: ReturnType<typeof runMaintenancePrune> | null = null;
      const maintAction = String(maintenanceRaw?.action ?? "prune").toLowerCase();
      if (
        maintenanceRaw
        && (maintAction === "prune"
          || maintAction === "purge"
          || maintAction === "prune_logs"
          || maintAction === "prune-logs"
          || maintAction === "prune-runs"
          || maintAction === "purge_logs"
          || maintAction === "purge-logs")
      ) {
        const targetRaw = String(maintenanceRaw.target ?? "logs").toLowerCase();
        const target: PruneTarget =
          targetRaw === "runs" || targetRaw === "all" || targetRaw === "project-logs"
            ? (targetRaw as PruneTarget)
            : "logs";
        const mode =
          maintAction === "purge" || maintAction === "purge_logs" || maintAction === "purge-logs"
            || maintenanceRaw.mode === "purge"
            ? "purge" as const
            : "prune" as const;
        // Safety: only apply deletes when model asked AND user message confirms.
        const userSaidApply = /\b(apply|delete|remove|go ahead|do it|yes.*prune|yes.*purge|prune.*now|purge.*now|confirm)\b/i.test(
          String(lastUserMsg),
        );
        const wantApply = maintenanceRaw.apply === true && userSaidApply;

        let root = process.cwd();
        let abortMaint: string | null = null;
        if (target === "project-logs") {
          const cp =
            (typeof maintenanceRaw.clonePath === "string" && maintenanceRaw.clonePath.trim())
            || (typeof clonePath === "string" && clonePath.trim())
            || (typeof runContext?.clonePath === "string" && runContext.clonePath.trim())
            || "";
          if (!cp) {
            abortMaint =
              "project-logs requires clonePath (absolute path to the target repo).";
          } else {
            const guard = assertAllowedClonePath(orch, cp);
            if (!guard.ok) abortMaint = guard.error;
            else root = resolveProjectRootFromPath(guard.resolved);
          }
        }

        if (abortMaint) {
          text += `\n\n_Maintenance blocked: ${abortMaint}_`;
        } else {
          maintenanceResult = runMaintenancePrune({
            root,
            target,
            mode,
            apply: wantApply,
            keepDays:
              typeof maintenanceRaw.keepDays === "number" ? maintenanceRaw.keepDays : undefined,
            maxKeep:
              typeof maintenanceRaw.maxKeep === "number" ? maintenanceRaw.maxKeep : undefined,
            keepNArchives:
              typeof maintenanceRaw.keepNArchives === "number"
                ? maintenanceRaw.keepNArchives
                : undefined,
            protectNames: collectActiveRunProtectNames(orch),
          });
          if (maintenanceRaw.apply === true && !wantApply && !maintenanceResult.apply) {
            text +=
              `\n\n_Maintenance dry-run only (say **apply** / **delete** to confirm). ` +
              `${maintenanceResult.summary}_`;
          } else {
            text += `\n\n_Maintenance: ${maintenanceResult.summary}_`;
          }
        }
      }

      let structuredData = null;
      if (wantsStructured) {
        // Use dedicated labeled extractor + shared balanced parser for robustness.
        // This is significantly better than naive regex (handles fences, strings, first-balanced, etc.).
        const rec = extractLabeledJson(text, 'RECOMMENDATION');
        const cfg = extractLabeledJson(text, 'CONFIG');
        const reconfig = extractLabeledJson(text, 'RECONFIG');
        structuredData = {
          recommendation: rec,
          config: cfg,
          reconfig,
          maintenance: maintenanceResult,
        };
      }

      if (wantsStructured && structuredData) {
        res.json({
          reply: text,
          model: modelStr,
          structured: structuredData,
          maintenance: maintenanceResult ?? undefined,
        });
      } else {
        res.json({
          reply: text,
          model: modelStr,
          maintenance: maintenanceResult ?? undefined,
        });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
