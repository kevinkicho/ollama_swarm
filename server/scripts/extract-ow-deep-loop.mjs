import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, "../src/swarm/OrchestratorWorkerDeepRunner.ts");
const outPath = join(__dirname, "../src/swarm/orchestratorWorkerDeepLoop.ts");
const lines = readFileSync(srcPath, "utf8").split(/\r?\n/);

const loopIdx = lines.findIndex((l) => l.includes("private async loop(cfg: RunConfig)"));
const tryIdx = lines.findIndex((l, i) => i > loopIdx && l === "    try {");
const catchIdx = lines.findIndex((l, i) => i > tryIdx && l.startsWith("    } catch (err)"));
if (loopIdx < 0 || tryIdx < 0 || catchIdx < 0) {
  throw new Error(JSON.stringify({ loopIdx, tryIdx, catchIdx }));
}

let body = lines.slice(tryIdx + 1, catchIdx).join("\n");
body = body
  .replace(/this\.topology!/g, "host.topology!")
  .replace(/this\.topology\?/g, "host.topology?")
  .replace(/this\.topology/g, "host.topology")
  .replace(/this\.opts\.manager/g, "host.manager")
  .replace(/this\.checkRoundBudget/g, "host.checkRoundBudget")
  .replace(/this\.appendSystem/g, "host.appendSystem")
  .replace(/this\.runAgent/g, "host.runAgent")
  .replace(/this\.stopping/g, "host.getStopping()")
  .replace(/this\.earlyStopDetail\s*=\s*([^;\n]+);/g, "host.setEarlyStopDetail($1);")
  .replace(/this\.transcript/g, "host.transcript")
  .replace(/this\.cyclePushbacks/g, "host.cyclePushbacks")
  .replace(/this\.runMidLeadSubtree/g, "host.runMidLeadSubtree")
  .replace(/this\.round/g, "host.round");

const dedented = body
  .split("\n")
  .map((l) => (l.startsWith("      ") ? l.slice(2) : l))
  .join("\n");

const header = `// Orchestrator-worker-deep cycle loop body — extracted from OrchestratorWorkerDeepRunner.loop.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { TranscriptEntry } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { PlanEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { staggerStart } from "./staggerStart.js";
import {
  buildTopPlanPrompt,
  buildTopSynthesisPrompt,
  buildOrchestratorReplanPrompt,
  parsePlan,
} from "./orchestratorWorkerDeepPromptHelpers.js";
// parsePlan is re-exported / shared from OW prompt helpers in deep runner
import { parsePlan as parsePlanOw } from "./orchestratorWorkerPromptHelpers.js";
import type { Assignment } from "./orchestratorWorkerPromptHelpers.js";
import type { DeepTopology } from "./orchestratorWorkerDeepTopology.js";

// Use OW parsePlan (deep reuses the same assignment schema)
const parsePlan = parsePlanOw;

export interface OwDeepLoopHost {
  manager: AgentManager;
  transcript: TranscriptEntry[];
  topology: DeepTopology | null;
  cyclePushbacks: Map<number, string>;
  getStopping: () => boolean;
  setEarlyStopDetail: (d: string | undefined) => void;
  appendSystem: (text: string) => void;
  checkRoundBudget: (
    cfg: RunConfig,
    unit: string,
    r: number,
    tokenBaseline: ReturnType<typeof snapshotLifetimeTokens>,
  ) => boolean;
  runAgent: (agent: Agent, prompt: string) => Promise<string>;
  runMidLeadSubtree: (
    midLead: Agent,
    pool: Agent[],
    coarseAssignment: Assignment,
    round: number,
    totalRounds: number,
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ) => Promise<void>;
}

export async function runOwDeepLoopBody(
  host: OwDeepLoopHost,
  cfg: RunConfig,
): Promise<void> {
`;

// Fix import mess - deep runner imports parsePlan from deep helpers or ow helpers?
writeFileSync(outPath, header + dedented + "\n}\n");
console.log("wrote", outPath);
const out = readFileSync(outPath, "utf8");
console.log("this. left", (out.match(/this\./g) || []).length);
console.log("body lines", catchIdx - tryIdx - 1);
