import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const path = join(dirname(fileURLToPath(import.meta.url)), "../src/swarm/DiscussionRunnerBase.ts");
let src = readFileSync(path, "utf8");

if (!src.includes("discussionRunAgent.js")) {
  src = src.replace(
    `import type { ToolResultHook } from "../tools/ToolDispatcher.js";`,
    `import type { ToolResultHook } from "../tools/ToolDispatcher.js";
import { runDiscussionAgentCore } from "./discussionRunAgent.js";`,
  );
}

const start = src.indexOf("  /**\n   * Core agent-prompt-execute-record pipeline");
const altStart = src.indexOf("  protected async runDiscussionAgent(");
const mStart = start >= 0 ? start : altStart;
const mEnd = src.indexOf("  /** Subclass must return its preset name");
if (mStart < 0 || mEnd < 0) throw new Error(`markers ${mStart} ${mEnd}`);

const thin = `  /**
   * Core agent-prompt-execute-record pipeline shared by all discussion runners.
   * Implementation extracted to discussionRunAgent.ts.
   */
  protected async runDiscussionAgent(
    agent: Agent,
    prompt: string,
    opts: RunAgentOpts,
  ): Promise<string> {
    return runDiscussionAgentCore(
      {
        manager: this.opts.manager,
        emit: (e) => this.opts.emit(e),
        logDiag: this.opts.logDiag,
        transcript: this.transcript,
        phase: this.phase,
        round: this.round,
        active: this.active,
        pendingToolTraceByAgent: this.pendingToolTraceByAgent,
        getStopping: () => this.stopping,
        appendSystem: (t, s) => this.appendSystem(t, s),
        emitAgentState: (s) => this.emitAgentState(s),
        buildDiscussionToolCoachHook: (a) => this.buildDiscussionToolCoachHook(a),
      },
      agent,
      prompt,
      opts,
    );
  }

`;

src = src.slice(0, mStart) + thin + src.slice(mEnd);

// Drop unused imports only used by runDiscussionAgent if no longer referenced
// Keep carefully - initCloneAndSpawn and others may still need some
const stillNeeds = {
  randomUUID: src.includes("randomUUID"),
  startSseAwareTurnWatchdog: src.includes("startSseAwareTurnWatchdog"),
  promptWithFailoverAuto: src.includes("promptWithFailoverAuto"),
  extractTextWithDiag: /extractTextWithDiag|looksLikeJunk|trackPostRetryJunk/.test(src),
  retryEmptyResponse: src.includes("retryEmptyResponse"),
  stripAgentText: src.includes("stripAgentText"),
  getAgentAddendum: src.includes("getAgentAddendum"),
  describeSdkError: src.includes("describeSdkError"),
  buildCheckpoint: /buildCheckpoint|writeCheckpoint/.test(src),
  makeBufferedToolHandler: /makeBufferedToolHandler|takePendingToolTrace/.test(src),
  discussionReaderProfile: src.includes("discussionReaderProfile"),
};

// Only remove clearly unused after thin wrapper
if (!stillNeeds.randomUUID) {
  src = src.replace(/import \{ randomUUID \} from "node:crypto";\n/, "");
}
if (!stillNeeds.startSseAwareTurnWatchdog) {
  src = src.replace(/import \{ startSseAwareTurnWatchdog \} from "\.\/sseAwareTurnWatchdog\.js";\n/, "");
}
if (!stillNeeds.promptWithFailoverAuto) {
  src = src.replace(/import \{ promptWithFailoverAuto \} from "\.\/promptWithFailoverAuto\.js";\n/, "");
}
if (!stillNeeds.extractTextWithDiag) {
  src = src.replace(/import \{ extractTextWithDiag, looksLikeJunk, trackPostRetryJunk \} from "\.\/extractText\.js";\n/, "");
}
if (!stillNeeds.retryEmptyResponse) {
  src = src.replace(/import \{ retryEmptyResponse \} from "\.\/promptAndExtract\.js";\n/, "");
}
if (!stillNeeds.stripAgentText) {
  src = src.replace(/import \{ stripAgentText \} from "@ollama-swarm\/shared\/stripAgentText";\n/, "");
}
if (!stillNeeds.getAgentAddendum) {
  src = src.replace(/import \{ getAgentAddendum \} from "@ollama-swarm\/shared\/topology";\n/, "");
}
if (!stillNeeds.describeSdkError) {
  src = src.replace(/import \{ describeSdkError \} from "\.\/sdkError\.js";\n/, "");
}
if (!stillNeeds.buildCheckpoint) {
  src = src.replace(/import \{ buildCheckpoint, writeCheckpoint \} from "\.\/checkpoint\.js";\n/, "");
}
if (!stillNeeds.makeBufferedToolHandler) {
  src = src.replace(
    /import \{\n  makeBufferedToolHandler,\n  takePendingToolTrace,\n  type ToolTraceEntry,\n\} from "\.\/toolCallTranscript\.js";\n/,
    `import {\n  type ToolTraceEntry,\n} from "./toolCallTranscript.js";\n`,
  );
}
if (!stillNeeds.discussionReaderProfile) {
  src = src.replace(/import \{ discussionReaderProfile \} from "\.\/discussionToolProfile\.js";\n/, "");
}

writeFileSync(path, src);
console.log("wired DiscussionRunnerBase", src.split("\n").length);
console.log("stillNeeds", stillNeeds);
