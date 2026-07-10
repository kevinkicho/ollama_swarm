import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, "../src/swarm/OrchestratorWorkerRunner.ts");
const outPath = join(__dirname, "../src/swarm/orchestratorWorkerLoop.ts");
const lines = readFileSync(srcPath, "utf8").split(/\r?\n/);

const loopIdx = lines.findIndex((l) => l.includes("private async loop(cfg: RunConfig)"));
const tryIdx = lines.findIndex((l, i) => i > loopIdx && l === "    try {");
const catchIdx = lines.findIndex((l, i) => i > tryIdx && l.startsWith("    } catch (err)"));
if (loopIdx < 0 || tryIdx < 0 || catchIdx < 0) {
  throw new Error(JSON.stringify({ loopIdx, tryIdx, catchIdx }));
}

let body = lines.slice(tryIdx + 1, catchIdx).join("\n");
body = body
  .replace(/this\.opts\.manager/g, "host.manager")
  .replace(/this\.checkRoundBudget/g, "host.checkRoundBudget")
  .replace(/this\.appendSystem/g, "host.appendSystem")
  .replace(/this\.runLeadTurn/g, "host.runLeadTurn")
  .replace(/this\.stopping/g, "host.getStopping()")
  .replace(/this\.runDiscussionAgent/g, "host.runDiscussionAgent")
  .replace(/this\.stats/g, "host.stats")
  .replace(/this\.earlyStopDetail\s*=\s*([^;\n]+);/g, "host.setEarlyStopDetail($1);")
  .replace(/this\.transcript/g, "host.transcript")
  .replace(/this\.runDecompositionPeerReview/g, "host.runDecompositionPeerReview")
  .replace(/this\.runWorkerTurn/g, "host.runWorkerTurn")
  .replace(/this\.dispatchHandoffWave/g, "host.dispatchHandoffWave")
  .replace(/this\.round/g, "host.round");

// Fix host.round - use r for postRoundCritique
body = body.replace(/round: host\.round,/g, "round: r,");

const dedented = body
  .split("\n")
  .map((l) => (l.startsWith("      ") ? l.slice(2) : l))
  .join("\n");

const header = `// Orchestrator-worker cycle loop body — extracted from OrchestratorWorkerRunner.loop.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { TranscriptEntry } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { PlanEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { staggerStart } from "./staggerStart.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";
import { runPostSynthesisCritique } from "./postSynthesisCritique.js";
import {
  buildLeadPlanPrompt,
  buildLeadSynthesisPrompt,
  parsePlan,
  summarizeEffortDistribution,
} from "./orchestratorWorkerPromptHelpers.js";
import type { Plan } from "./orchestratorWorkerPromptHelpers.js";

export interface OwLoopHost {
  manager: AgentManager;
  transcript: TranscriptEntry[];
  stats: any;
  getStopping: () => boolean;
  setEarlyStopDetail: (d: string | undefined) => void;
  appendSystem: (text: string, summary?: unknown) => void;
  checkRoundBudget: (
    cfg: RunConfig,
    unit: string,
    r: number,
    tokenBaseline: ReturnType<typeof snapshotLifetimeTokens>,
  ) => boolean;
  runDiscussionAgent: (agent: Agent, prompt: string, opts: unknown) => Promise<string>;
  runLeadTurn: (
    agent: Agent,
    round: number,
    totalRounds: number,
    prompt: string,
    kind: "plan" | "synthesis",
  ) => Promise<string>;
  runWorkerTurn: (
    agent: Agent,
    round: number,
    totalRounds: number,
    subtask: string,
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
    successCriteria?: string,
  ) => Promise<void>;
  dispatchHandoffWave: (
    workers: Agent[],
    round: number,
    totalRounds: number,
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ) => Promise<void>;
  runDecompositionPeerReview: (
    reviewer: Agent,
    round: number,
    totalRounds: number,
    plan: Plan,
    userDirective?: string,
  ) => Promise<void>;
}

export async function runOwLoopBody(
  host: OwLoopHost,
  cfg: RunConfig,
): Promise<void> {
`;

writeFileSync(outPath, header + dedented + "\n}\n");
console.log("wrote", outPath, "body lines", catchIdx - tryIdx - 1);
const out = readFileSync(outPath, "utf8");
console.log("this. left", (out.match(/this\./g) || []).length);
console.log("setEarlyStop sample", out.match(/setEarlyStopDetail\([^)]{0,80}/g)?.slice(0, 5));
