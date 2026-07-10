import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, "../src/swarm/StigmergyRunner.ts");
const outPath = join(__dirname, "../src/swarm/stigmergyTurns.ts");
const lines = readFileSync(srcPath, "utf8").split(/\r?\n/);

function methodRange(name) {
  const s = lines.findIndex((l) => l.includes(`private async ${name}(`));
  if (s < 0) throw new Error(`missing ${name}`);
  let e = lines.findIndex(
    (l, i) => i > s && l.match(/^\s{2}private (async )?[a-zA-Z]/),
  );
  if (e < 0) throw new Error(`end for ${name}`);
  return lines.slice(s, e);
}

const methods = ["runTerritoryPlanPass", "runReportOutPass", "runExplorerTurn"];
let body = methods.map((m) => methodRange(m).join("\n")).join("\n\n");

body = body
  .replace(/this\.stopping/g, "host.getStopping()")
  .replace(/this\.opts\.manager/g, "host.manager")
  .replace(/this\.opts\.emit/g, "host.emit")
  .replace(/this\.opts\.logDiag/g, "host.logDiag")
  .replace(/this\.appendSystem/g, "host.appendSystem")
  .replace(/this\.emitAgentState/g, "host.emitAgentState")
  .replace(/this\.stats/g, "host.stats")
  .replace(/this\.active/g, "host.active")
  .replace(/this\.annotations/g, "host.annotations")
  .replace(/this\.round/g, "host.round")
  .replace(/this\.territoryAssignments/g, "host.territoryAssignments")
  .replace(/this\.runAgent/g, "host.runAgent")
  .replace(/this\.applyAnnotation/g, "host.applyAnnotation");

for (const m of methods) {
  body = body.replace(
    new RegExp(`private async ${m}\\(\\s*`),
    `export async function ${m}(\n  host: StigmergyTurnsHost,\n  `,
  );
}

// runReportOutPass has no args after host
body = body.replace(
  /export async function runReportOutPass\(\n  host: StigmergyTurnsHost,\n  \): Promise/,
  "export async function runReportOutPass(\n  host: StigmergyTurnsHost,\n): Promise",
);

body = body
  .split("\n")
  .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
  .join("\n");

const header = `// Stigmergy territory / report-out / explorer turn — extracted from StigmergyRunner.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type {
  AgentState,
  SwarmEvent,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { stripAgentText } from "@ollama-swarm/shared/stripAgentText";
import { getAgentAddendum } from "@ollama-swarm/shared/topology";
import {
  type AnnotationState,
  type ParsedAnnotation,
  rankingScore,
  stripAnnotationEnvelope,
  parseAnnotation,
  buildExplorerPrompt,
  buildTerritoryPlanPrompt,
  parseTerritoryPlan,
  describeSdkError,
} from "./stigmergyPromptHelpers.js";
import { pheromoneHeatmap } from "./pheromoneHeatmap.js";

export interface StigmergyTurnsHost {
  manager: AgentManager;
  emit: (e: SwarmEvent) => void;
  logDiag?: (entry: unknown) => void;
  annotations: Map<string, AnnotationState>;
  territoryAssignments: Map<number, string>;
  round: number;
  active: RunConfig | undefined;
  stats: {
    countTurn: (id: string) => void;
    recordTokens: (id: string, p: number, r: number) => void;
    onTiming: (id: string, success: boolean, elapsedMs: number) => void;
    onRetry: (id: string) => void;
    recordJunkPostRetry: (id: string, junk: boolean) => number;
  };
  getStopping: () => boolean;
  appendSystem: (text: string, summary?: unknown) => void;
  emitAgentState: (s: AgentState) => void;
  runAgent: (
    agent: Agent,
    prompt: string,
    opts?: {
      transformEntry?: (text: string) => { text: string; summary?: TranscriptEntrySummary };
    },
  ) => Promise<string>;
  applyAnnotation: (ann: ParsedAnnotation) => void;
}

`;

if (body.includes("this.")) {
  console.warn("leftover this.", body.match(/this\.\w+/g));
}

writeFileSync(outPath, header + body + "\n");
console.log("wrote", outPath, "lines", (header + body).split("\n").length);
