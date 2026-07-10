import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, "../src/swarm/DiscussionRunnerBase.ts");
const outPath = join(__dirname, "../src/swarm/discussionRunAgent.ts");
const lines = readFileSync(srcPath, "utf8").split(/\r?\n/);

const start = lines.findIndex((l) => l.includes("protected async runDiscussionAgent("));
const end = lines.findIndex(
  (l, i) => i > start && l.includes("protected abstract getPresetName()"),
);
if (start < 0 || end < 0) throw new Error(JSON.stringify({ start, end }));

// Include comment block above method
let commentStart = start;
while (commentStart > 0 && (lines[commentStart - 1].trim().startsWith("*") || lines[commentStart - 1].trim().startsWith("/**") || lines[commentStart - 1].trim() === "")) {
  commentStart--;
}
// Actually start at method signature only for extraction body

let body = lines.slice(start, end).join("\n");
// Convert method to free function
body = body.replace(
  /protected async runDiscussionAgent\(\s*agent: Agent,\s*prompt: string,\s*opts: RunAgentOpts,\s*\): Promise<string> \{/,
  `export async function runDiscussionAgentCore(
  host: DiscussionRunAgentHost,
  agent: Agent,
  prompt: string,
  opts: RunAgentOpts,
): Promise<string> {`,
);

body = body
  .replace(/this\.opts\.manager/g, "host.manager")
  .replace(/this\.opts\.logDiag/g, "host.logDiag")
  .replace(/this\.opts\.emit/g, "host.emit")
  .replace(/this\.emitAgentState/g, "host.emitAgentState")
  .replace(/this\.appendSystem/g, "host.appendSystem")
  .replace(/this\.active/g, "host.active")
  .replace(/this\.stopping/g, "host.getStopping()")
  .replace(/this\.pendingToolTraceByAgent/g, "host.pendingToolTraceByAgent")
  .replace(/this\.buildDiscussionToolCoachHook/g, "host.buildDiscussionToolCoachHook")
  .replace(/this\.transcript/g, "host.transcript")
  .replace(/this\.phase/g, "host.phase")
  .replace(/this\.round/g, "host.round");

// Dedent 2 spaces
body = body
  .split("\n")
  .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
  .join("\n");

const header = `// Shared discussion agent prompt pipeline — extracted from DiscussionRunnerBase.runDiscussionAgent.

import { randomUUID } from "node:crypto";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
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
import { describeSdkError } from "./sdkError.js";
import { buildCheckpoint, writeCheckpoint } from "./checkpoint.js";
import type { RunAgentOpts } from "./postRoundCritiqueTypes.js";
import { discussionReaderProfile } from "./discussionToolProfile.js";
import {
  makeBufferedToolHandler,
  takePendingToolTrace,
  type ToolTraceEntry,
} from "./toolCallTranscript.js";
import type { ToolResultHook } from "../tools/ToolDispatcher.js";

export interface DiscussionRunAgentHost {
  manager: AgentManager;
  emit: (e: SwarmEvent) => void;
  logDiag?: (entry: unknown) => void;
  transcript: TranscriptEntry[];
  phase: SwarmPhase;
  round: number;
  active: RunConfig | undefined;
  pendingToolTraceByAgent: Map<string, ToolTraceEntry[]>;
  getStopping: () => boolean;
  appendSystem: (text: string, summary?: TranscriptEntrySummary) => void;
  emitAgentState: (s: AgentState) => void;
  buildDiscussionToolCoachHook: (agent: Agent) => ToolResultHook | undefined;
}

`;

writeFileSync(outPath, header + body + "\n");
console.log("wrote", outPath, "lines", (header + body).split("\n").length);
console.log("this. left", ((header + body).match(/this\./g) || []).length);
