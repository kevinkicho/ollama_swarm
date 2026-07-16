export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type BrainConfigPatch = Record<string, unknown> & {
  preset?: string;
  model?: string;
};

// Context shape for during-run Brain assistance.
// Kept compact to avoid token bloat; use summaries.
export interface RunBrainContext {
  runId: string;
  preset?: string;
  userDirective?: string;
  phase?: string;
  clonePath?: string;
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
  // Summarized recent transcript (use formatServerSummary or similar)
  recentTranscript?: Array<{
    role: string;
    text: string;
    summaryKind?: string;
    summary?: any;
  }>;
  // For blackboard: key board info
  boardCounts?: any;
  recentTodos?: Array<{ id: string; description: string; status: string }>;
  agentCount?: number;
  // Additional metadata
  activeAgents?: number;
  wallClockMs?: number;
  /** Peer/hierarchy/control deliberation tail for Brain governance awareness. */
  deliberation?: Array<{
    ts?: number;
    layer?: string;
    verdict?: string;
    subject?: string;
    claim?: string;
    validationReason?: string;
    proposer?: string;
    validator?: string;
  }>;
}

export type RunReconfigPatch = {
  rounds?: number;
  wallClockCapMs?: number;
  wallClockCapMin?: number;
  tokenBudget?: number;
  extendRounds?: number;
  extendWallClockCapMin?: number;
  extendTokenBudget?: number;
  thinkGuardRefereeEnabled?: boolean;
  thinkGuardRefereeMaxCallsPerRun?: number;
  thinkGuardRefereeMinThinkChars?: number;
  thinkGuardRefereeThinkTailMinChars?: number;
  thinkGuardRefereeThinkTailMaxChars?: number;
  thinkGuardRefereeMaxOutputTokens?: number;
};
