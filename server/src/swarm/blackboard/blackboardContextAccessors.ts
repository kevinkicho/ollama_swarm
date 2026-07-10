// Thin context-accessor bag for BlackboardRunner — consolidates *Context() methods.

import type { BlackboardRunnerFields } from "./runnerContextTypes.js";
import type { LifecycleContext } from "./lifecycleRunner.js";
import type { ContractContext } from "./contractBuilder.js";
import type { TierContext } from "./tierRunner.js";
import type { PlannerContext } from "./plannerRunner.js";
import type { WorkerContext } from "./workerRunner.js";
import type { PromptContext } from "./promptRunner.js";
import type { CapContext } from "./capManager.js";
import type { ReplanContext } from "./replanManager.js";
import type { AuditorContext } from "./auditorRunner.js";
import type { AdaptiveWatchdogContext } from "./adaptiveWorkerWatchdog.js";
import type { QueueReaperContext } from "./queueReaper.js";
import type { RunnerUtilContext } from "./runnerUtil.js";
import {
  lifecycleContext as lifecycleContextBuilder,
  contractContext as contractContextBuilder,
  tierContext as tierContextBuilder,
  plannerContext as plannerContextBuilder,
  workerContext as workerContextBuilder,
  promptContext as promptContextBuilder,
  capContext as capContextBuilder,
  replanContext as replanContextBuilder,
  auditorContext as auditorContextBuilder,
  adaptiveWatchdogCtx as adaptiveWatchdogCtxBuilder,
  utilCtx as utilCtxBuilder,
} from "./contextBuilders.js";

/** All context builders BlackboardRunner methods need, from a fields view. */
export interface BlackboardContexts {
  fields: BlackboardRunnerFields;
  util: () => RunnerUtilContext;
  lifecycle: () => LifecycleContext;
  contract: () => ContractContext;
  tier: () => TierContext;
  planner: () => PlannerContext;
  worker: () => WorkerContext;
  prompt: () => PromptContext;
  cap: () => CapContext;
  replan: () => ReplanContext;
  auditor: () => AuditorContext;
  adaptiveWatchdog: () => AdaptiveWatchdogContext;
}

export function buildBlackboardContexts(fields: BlackboardRunnerFields): BlackboardContexts {
  return {
    fields,
    util: () => utilCtxBuilder(fields),
    lifecycle: () => lifecycleContextBuilder(fields),
    contract: () => contractContextBuilder(fields),
    tier: () => tierContextBuilder(fields),
    planner: () => plannerContextBuilder(fields),
    worker: () => workerContextBuilder(fields),
    prompt: () => promptContextBuilder(fields),
    cap: () => capContextBuilder(fields),
    replan: () => replanContextBuilder(fields),
    auditor: () => auditorContextBuilder(fields),
    adaptiveWatchdog: () => adaptiveWatchdogCtxBuilder(fields),
  };
}

/** Build QueueReaperContext from runner-owned pieces (avoids fat method body). */
export function buildQueueReaperContext(input: QueueReaperContext): QueueReaperContext {
  return input;
}
