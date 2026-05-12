// Shared types to break the DiscussionRunnerBase ↔ postRoundCritique import cycle.
// Previously RunAgentOpts was in DiscussionRunnerBase, causing postRoundCritique
// to import from the base (creating a cycle).

import type { Agent } from "../services/AgentManager.js";
import type { TranscriptEntrySummary, TranscriptEntry } from "../types.js";

export interface RunAgentOpts {
  /** Runner name for diagnostic logging (e.g. "council", "debate-judge") */
  runnerName: string;
  /** Agent name for the prompt call: "swarm-read" (discussion) or "swarm" (write-capable) */
  agentName?: "swarm" | "swarm-read";
  /** Custom summary for the transcript entry. Can be a static value or a
   *  function that receives the final stripped text and returns a summary. */
  enrichSummary?: TranscriptEntrySummary | ((text: string) => TranscriptEntrySummary | undefined);
  /** Optional model override for this specific prompt call (e.g. dynamic routing) */
  modelOverride?: string;
  /** Called after the transcript entry is pushed (for multiWriter collection, etc.) */
  onEntryPushed?: (entry: TranscriptEntry, strippedText: string) => void;
  /** Stats instance to record timing/retry/junk metrics. If provided,
   *  onTiming/onRetry/recordTokens are wired automatically. */
  stats?: {
    countTurn(agentId: string): void;
    onTiming(agentId: string, success: boolean, elapsedMs: number): void;
    onRetry(agentId: string): void;
    recordJunkPostRetry(agentId: string, isJunk: boolean): number;
    recordTokens(agentId: string, promptTokens: number, responseTokens: number): void;
  };
}
