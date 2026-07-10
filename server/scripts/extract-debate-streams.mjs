import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, "../src/swarm/DebateJudgeRunner.ts");
const outPath = join(__dirname, "../src/swarm/debateStreams.ts");
const lines = readFileSync(srcPath, "utf8").split(/\r?\n/);

const startIdx = lines.findIndex((l) =>
  l.includes("private async runSingleStreamDebate("),
);
const runAgentIdx = lines.findIndex(
  (l, i) => i > startIdx && l.includes("private async runAgent("),
);

// Drop rankParallelPropositions thin wrapper — keep only real logic methods
const rankIdx = lines.findIndex(
  (l, i) => i > startIdx && l.includes("private async rankParallelPropositions("),
);
const judgeIdx = lines.findIndex(
  (l, i) => i > startIdx && l.includes("private async runJudgeTurn("),
);

// Extract: single, multi, crossStream, debater, nextAction, judge (skip rank)
const chunks = [
  lines.slice(startIdx, lines.findIndex((l, i) => i > startIdx && l.includes("private async runMultiStreamDebate("))),
];
// Better: extract line ranges by method
function methodRange(name) {
  const s = lines.findIndex((l) => l.includes(`private async ${name}(`));
  if (s < 0) throw new Error(`missing ${name}`);
  // find next private async or end at runAgent
  let e = lines.findIndex(
    (l, i) =>
      i > s &&
      (l.match(/^\s{2}private async /) || l.match(/^\s{2}\/\*\*/)),
  );
  if (e < 0) e = runAgentIdx;
  return lines.slice(s, e);
}

const methods = [
  "runSingleStreamDebate",
  "runMultiStreamDebate",
  "runCrossStreamJudge",
  "runDebaterTurn",
  "runNextActionPhase",
  "runJudgeTurn",
];

let body = methods.map((m) => methodRange(m).join("\n")).join("\n\n");

// this. → host. with special cases
body = body
  .replace(/this\.checkRoundBudget/g, "host.checkRoundBudget")
  .replace(/this\.stopping/g, "host.getStopping()")
  .replace(/this\.transcript/g, "host.transcript")
  .replace(/this\.appendSystem/g, "host.appendSystem")
  .replace(/this\.opts\.manager/g, "host.manager")
  .replace(/this\.opts\.logDiag/g, "host.logDiag")
  .replace(/this\.proposition/g, "host.proposition")
  .replace(/this\.runAgent/g, "host.runAgent")
  // internal calls: free functions, not host (avoid circular wrappers)
  .replace(/await this\.runDebaterTurn\(/g, "await runDebaterTurn(host, ")
  .replace(/await this\.runJudgeTurn\(/g, "await runJudgeTurn(host, ")
  .replace(/this\.runSingleStreamDebate\(/g, "runSingleStreamDebate(host, ")
  .replace(/await this\.runCrossStreamJudge\(/g, "await runCrossStreamJudge(host, ")
  .replace(/this\.earlyStopDetail\s*=\s*`([^`]+)`/g, "host.setEarlyStopDetail(`$1`)")
  .replace(/this\.earlyStopDetail\s*=\s*([^\n;]+);/g, "host.setEarlyStopDetail($1);");

// Fix leftover this.
if (body.includes("this.")) {
  console.warn("leftover this.:", body.match(/this\.\w+/g));
}

// Convert method defs to export async function
for (const m of methods) {
  const re = new RegExp(
    `private async ${m}\\(\\s*`,
  );
  body = body.replace(re, `export async function ${m}(\n  host: DebateStreamsHost,\n  `);
}

// Dedent 2 spaces from method bodies that were class-level
body = body
  .split("\n")
  .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
  .join("\n");

const header = `// Debate stream/cycle helpers — extracted from DebateJudgeRunner.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { TranscriptEntry, TranscriptEntrySummary } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import { extractText } from "./extractText.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { describeSdkError } from "./sdkError.js";
import { deriveProposition, type DerivedProposition } from "./propositionDerive.js";
import { DebateStream } from "./DebateStream.js";
import {
  DEFAULT_PROPOSITION,
  buildDebaterPrompt,
  buildJudgePrompt,
  scanImplementerForNoOp,
  buildImplementerPrompt,
  buildReviewerPrompt,
  buildSignoffPrompt,
  type ParsedDebateVerdict,
  parseDebateVerdict,
  buildCrossStreamJudgePrompt,
  parseCrossStreamPick,
} from "./debatePromptHelpers.js";

export interface DebateStreamsHost {
  manager: AgentManager;
  transcript: TranscriptEntry[];
  proposition: string | undefined;
  logDiag?: (entry: unknown) => void;
  getStopping: () => boolean;
  setEarlyStopDetail: (d: string | undefined) => void;
  appendSystem: (text: string, summary?: unknown) => void;
  checkRoundBudget: (
    cfg: RunConfig,
    unit: string,
    r: number,
    tokenBaseline: ReturnType<typeof snapshotLifetimeTokens>,
  ) => boolean;
  runAgent: (
    agent: Agent,
    prompt: string,
    debateTag?: { role: "pro" | "con" | "judge"; round: number },
    enrichSummary?: (text: string) => TranscriptEntrySummary | undefined,
    agentName?: "swarm" | "swarm-read",
    stream?: DebateStream,
  ) => Promise<void>;
}

`;

writeFileSync(outPath, header + body + "\n");
console.log("wrote", outPath);
// quick sanity
const out = readFileSync(outPath, "utf8");
console.log("lines", out.split("\n").length);
console.log("this. left", (out.match(/this\./g) || []).length);
console.log("export functions", (out.match(/export async function/g) || []).length);
