/**
 * Brain OS dispatcher — recruits ephemeral helper agents to resolve run conflicts.
 * @see docs/design/brain-os-agentic-dispatch.md
 */

import type {
  BrainDispatchRequest,
  BrainDispatchResult,
  HelperPrivilege,
} from "@ollama-swarm/shared/brainOs";
import { defaultBrainDispatchBudget } from "@ollama-swarm/shared/brainOs";
import { BrainOsBudgetLedger } from "./budgets.js";
import { applyBrainEffects, type BrainEffectApplicatorDeps } from "./effects.js";
import { parseHelperResult } from "./parseHelperResult.js";
import { runHelperSession, type HelperSessionDeps } from "./helperSession.js";

export interface BrainOsConfig {
  enabled?: boolean;
  maxHelpersPerRun?: number;
  maxConcurrentHelpers?: number;
  maxDepth?: number;
  maxWallMsPerDispatch?: number;
  maxToolTurnsPerDispatch?: number;
  helperModel?: string;
  privilegeCap?: HelperPrivilege;
}

export interface BrainOsDispatcher {
  readonly enabled: boolean;
  readonly ledger: BrainOsBudgetLedger;
  dispatch(
    req: BrainDispatchRequest,
    deps: HelperSessionDeps & {
      effectDeps: Omit<BrainEffectApplicatorDeps, "privilege" | "onEffect">;
    },
  ): Promise<BrainDispatchResult>;
}

function capPrivilege(
  requested: HelperPrivilege,
  cap?: HelperPrivilege,
): HelperPrivilege {
  if (!cap) return requested;
  const rank: Record<HelperPrivilege, number> = {
    observer: 0,
    repairer: 1,
    runner: 2,
    board_officer: 3,
    arbiter: 4,
  };
  return rank[requested] <= rank[cap] ? requested : cap;
}

export function createBrainOsDispatcher(cfg: BrainOsConfig = {}): BrainOsDispatcher {
  const enabled = cfg.enabled === true;
  const ledger = new BrainOsBudgetLedger({
    maxHelpersPerRun: cfg.maxHelpersPerRun ?? 8,
    maxConcurrentHelpers: cfg.maxConcurrentHelpers ?? 2,
  });
  const maxDepth = cfg.maxDepth ?? 2;

  return {
    enabled,
    ledger,
    async dispatch(req, deps) {
      const t0 = Date.now();
      if (!enabled) {
        return {
          dispatchId: "disabled",
          status: "blocked",
          summary: "brain OS disabled",
          effects: [{ type: "none" }],
          usage: { wallMs: 0 },
        };
      }
      if (req.depth > maxDepth) {
        return {
          dispatchId: "depth-exceeded",
          status: "blocked",
          summary: `brain OS maxDepth ${maxDepth} exceeded`,
          effects: [{ type: "none" }],
          usage: { wallMs: 0 },
        };
      }
      if (!ledger.beginHelper()) {
        return {
          dispatchId: "budget-exhausted",
          status: "blocked",
          summary: "brain OS helper budget exhausted",
          effects: [{ type: "none" }],
          usage: { wallMs: 0 },
        };
      }

      const privileges = capPrivilege(req.privileges, cfg.privilegeCap);
      const budget = {
        ...defaultBrainDispatchBudget(),
        maxWallMs: cfg.maxWallMsPerDispatch ?? req.budget.maxWallMs,
        maxToolTurns: cfg.maxToolTurnsPerDispatch ?? req.budget.maxToolTurns,
        maxDepth,
        maxSubAgents: req.budget.maxSubAgents,
      };
      const model = req.helperModel ?? cfg.helperModel ?? "deepseek-v4-flash:cloud";

      deps.effectDeps.appendSystem(
        `[brain-os] dispatch kind=${req.kind} privilege=${privileges} depth=${req.depth} todo=${req.context.todoId ?? "—"}`,
      );

      try {
        const raw = await runHelperSession(
          {
            ...req,
            privileges,
            budget,
            helperModel: model,
          },
          deps,
        );
        const result = parseHelperResult(raw, Date.now() - t0);
        if (req.depth > 0) ledger.recordChild();
        ledger.recordDispatch(result.status, result.usage);

        const { applied, rejected } = await applyBrainEffects(result.effects, {
          ...deps.effectDeps,
          privilege: privileges,
          onEffect: (ok) => ledger.recordEffect(ok),
        });

        deps.effectDeps.appendSystem(
          `[brain-os] done status=${result.status} effects+${applied}/-${rejected}: ${result.summary.slice(0, 240)}`,
        );
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ledger.recordDispatch("blocked", { wallMs: Date.now() - t0 });
        deps.effectDeps.appendSystem(`[brain-os] dispatch failed: ${msg.slice(0, 300)}`);
        return {
          dispatchId: "error",
          status: "blocked",
          summary: msg.slice(0, 500),
          effects: [{ type: "none" }],
          usage: { wallMs: Date.now() - t0 },
        };
      } finally {
        ledger.endHelper();
      }
    },
  };
}
