// MoA single-agent prompt turn — extracted from MoaRunner.runOne.

import { randomUUID } from "node:crypto";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { SwarmEvent, TranscriptEntry } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractText } from "./extractText.js";
import { finalizeAgentOutput } from "@ollama-swarm/shared/finalizeAgentOutput";
import { describeSdkError } from "./sdkError.js";
import type { MultiWriterState } from "./multiWriterState.js";

export interface MoaRunOneHost {
  manager: AgentManager;
  active: RunConfig | undefined;
  multiWriter: MultiWriterState | undefined;
  transcript: TranscriptEntry[];
  emit: (e: SwarmEvent) => void;
  appendSystem: (text: string) => void;
  markStatus: (agentId: string, status: "thinking" | "ready") => void;
  emitAgentStatus: (
    agent: Agent,
    status: "thinking" | "ready",
    thinkingSince?: number,
  ) => void;
}

/**
 * One prompt → cleaned text. Records the agent message in the transcript.
 * Throws on transport errors so the caller can decide whether to abort.
 */
export async function moaRunOne(
  host: MoaRunOneHost,
  agent: Agent,
  prompt: string,
  _label: string,
): Promise<string> {
  const ctrl = new AbortController();
  const startedAt = Date.now();
  host.markStatus(agent.id, "thinking");
  host.emitAgentStatus(agent, "thinking", startedAt);
  try {
    const { discussionBuilderProfile } = await import("./discussionToolProfile.js");
    const proposerAgentName = host.multiWriter?.isActive()
      ? discussionBuilderProfile(host.active)
      : host.active?.moaProposerTools
        ? "swarm-read"
        : "swarm";
    const res = (await promptWithFailoverAuto(agent, prompt, {
      signal: ctrl.signal,
      manager: host.manager,
      formatExpect: "free",
      describeError: (e) => describeSdkError(e),
      agentName: proposerAgentName,
      ...(host.active?.localPath && host.multiWriter?.isActive()
        ? { runId: host.active?.runId }
        : {}),
    })) as { data: { parts: Array<{ type: "text"; text: string }> } };
    const raw = extractText(res) ?? "";
    const stripped = finalizeAgentOutput(raw, { role: "general" });
    const cleaned = stripped.finalText;
    if (host.multiWriter?.isActive()) {
      const proposalResult = await host.multiWriter.addProposal(agent, cleaned);
      if (!proposalResult.skipped && proposalResult.hunks.length > 0) {
        host.appendSystem(
          `[${agent.id}] proposed ${proposalResult.hunks.length} hunk(s)` +
            (proposalResult.fromWorkingTree ? " (workingTree snapshot)" : "") +
            ` — collected for reconciliation.`,
        );
      }
    }
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: agent.id,
      agentIndex: agent.index,
      text: cleaned,
      ts: Date.now(),
    };
    host.transcript.push(entry);
    host.emit({ type: "transcript_append", entry });
    return cleaned;
  } finally {
    host.markStatus(agent.id, "ready");
    host.emitAgentStatus(agent, "ready");
  }
}
