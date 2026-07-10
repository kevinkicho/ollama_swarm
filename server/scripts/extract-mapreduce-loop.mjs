import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, "../src/swarm/MapReduceRunner.ts");
const outPath = join(__dirname, "../src/swarm/mapReduceLoopBody.ts");
const src = readFileSync(srcPath, "utf8");
const lines = src.split(/\r?\n/);

const loopIdx = lines.findIndex((l) =>
  l.includes("private async loop(cfg: RunConfig, clonePath: string)"),
);
// Outer try of loop is indented with 4 spaces; nested try/catch use more.
const tryIdx = lines.findIndex((l, i) => i > loopIdx && l === "    try {");
const catchIdx = lines.findIndex(
  (l, i) => i > tryIdx && l.startsWith("    } catch (err)"),
);
if (loopIdx < 0 || tryIdx < 0 || catchIdx < 0) {
  throw new Error(`markers not found: ${JSON.stringify({ loopIdx, tryIdx, catchIdx })}`);
}

let text = lines.slice(tryIdx + 1, catchIdx).join("\n");
const replacements = [
  [/this\.opts\.manager/g, "host.manager"],
  [/this\.opts\.repos/g, "host.repos"],
  [/this\.opts\.emit/g, "host.emit"],
  [/this\.appendSystem/g, "host.appendSystem"],
  [/this\.stopping/g, "host.getStopping()"],
  [/this\.earlyStopDetail/g, "host.earlyStopDetail"],
  [/this\.checkRoundBudget/g, "host.checkRoundBudget"],
  [/this\.transcript/g, "host.transcript"],
  [/this\.nextCycleReframings/g, "host.nextCycleReframings"],
  [/this\.mapperSlices/g, "host.mapperSlices"],
  [/this\.mappersComplete/g, "host.mappersComplete"],
  [/this\.runDiscussionAgent/g, "host.runDiscussionAgent"],
  [/this\.stats/g, "host.stats"],
  [/this\.runStreamingMapReduce/g, "host.runStreamingMapReduce"],
  [/this\.runMapperTurn/g, "host.runMapperTurn"],
  [/this\.runReducerTurn/g, "host.runReducerTurn"],
  [/this\.round/g, "host.round"],
];
for (const [re, rep] of replacements) text = text.replace(re, rep);

const dedented = text
  .split("\n")
  .map((l) => (l.startsWith("      ") ? l.slice(2) : l))
  .join("\n");

const header = `// Map-reduce loop body (slicing + map/reduce cycles) — extracted from MapReduceRunner.loop.

import { randomUUID } from "node:crypto";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { SwarmEvent, TranscriptEntry } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { RepoService } from "../services/RepoService.js";
import { buildImportGraph, clusterByImports } from "./importGraph.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { staggerStart } from "./staggerStart.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";
import { runPostSynthesisCritique } from "./postSynthesisCritique.js";
import {
  SKIP_ENTRIES,
  sliceRoundRobin,
  sliceSizeBalanced,
  parseReducerReTaskLines,
} from "./mapReducePromptHelpers.js";
import { runCouncilMapperSlice, type CouncilMapperResult } from "./mapReduceCouncilMapper.js";

export interface MapReduceLoopHost {
  manager: AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
  transcript: TranscriptEntry[];
  mapperSlices: Record<string, string[]>;
  nextCycleReframings: Map<number, string>;
  mappersComplete: Set<string>;
  earlyStopDetail: string | undefined;
  round: number;
  stats: any;
  getStopping: () => boolean;
  appendSystem: (text: string, summary?: unknown) => void;
  checkRoundBudget: (
    cfg: RunConfig,
    unit: string,
    r: number,
    tokenBaseline: ReturnType<typeof snapshotLifetimeTokens>,
  ) => boolean;
  runDiscussionAgent: (agent: Agent, prompt: string, opts: unknown) => Promise<unknown>;
  runStreamingMapReduce: (input: {
    mappers: Agent[];
    reducer: Agent;
    slices: string[][];
    reframingsThisCycle: Map<number, string>;
    seedSnapshot: readonly TranscriptEntry[];
    round: number;
    totalRounds: number;
    userDirective?: string;
  }) => Promise<void>;
  runMapperTurn: (
    agent: Agent,
    round: number,
    totalRounds: number,
    slice: readonly string[],
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
    reframing?: string,
  ) => Promise<void>;
  runReducerTurn: (
    agent: Agent,
    round: number,
    totalRounds: number,
    isFinal?: true,
    userDirective?: string,
  ) => Promise<void>;
}

export async function runMapReduceLoopBody(
  host: MapReduceLoopHost,
  cfg: RunConfig,
  clonePath: string,
): Promise<void> {
`;

writeFileSync(outPath, header + dedented + "\n}\n");
console.log("wrote", outPath, "body lines", catchIdx - tryIdx - 1);
