// Shared types for the resilience module

export type ErrorCategory =
  | "quota"
  | "network"
  | "timeout"
  | "model-output"
  | "auth"
  | "disk"
  | "oom"
  | "runner-bug"
  | "user-stop"
  | "cap"
  | "git"
  | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  rawMessage: string;
  detail: string;
  retryable: boolean;
}

export interface AttemptRecord {
  success: boolean;
  ts: number;
}

export interface ModelHealthInput {
  model: string;
  recentAttempts: readonly AttemptRecord[];
  windowSize?: number;
  minSamples?: number;
  successThreshold?: number;
}

export interface ModelHealthVerdict {
  model: string;
  successRate: number;
  sampleCount: number;
  degraded: boolean;
  reason: string;
}

export type FailoverAction = "retry-same" | "swap" | "give-up";

export interface FailoverDecision {
  action: FailoverAction;
  nextModel?: string;
  reason: string;
}

export interface FailoverInput {
  currentModel: string;
  classified: ClassifiedError;
  failoverChain: readonly string[];
  alreadyTried: ReadonlySet<string>;
}

export interface FailoverConfig {
  failoverChain: readonly string[];
  localTags?: readonly string[];
  localPreferred?: readonly string[];
  enableHealthSwap?: boolean;
  maxSwaps?: number;
  promptFn?: PromptFn;
}

export type PromptFn = (
  agent: unknown,
  promptText: string,
  opts: PromptWithRetryOptions,
) => Promise<unknown>;

export interface PromptWithRetryOptions {
  signal: AbortSignal;
  onRetry?: (info: RetryInfo) => void;
  describeError?: (err: unknown) => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  onTiming?: (info: TimingInfo) => void;
  agentName?: string;
  onTokens?: (info: { promptTokens: number; responseTokens: number }) => void;
  manager?: unknown;
  formatExpect?: "json" | "free";
  ollamaDirect?: { baseUrl: string };
  ollamaFormat?: "json" | Record<string, unknown>;
  logDiag?: (record: unknown) => void;
  promptAddendum?: string;
  ollamaOptions?: {
    temperature?: number;
    top_p?: number;
    [key: string]: unknown;
  };
  modelOverride?: string;

  /** MCP servers string (e.g. "fetch=..." or "search=...") for tool-augmented profiles. Passed through even if not declared on every path. */
  mcpServers?: string;
  webToolsConfig?: { webTools?: boolean; plannerTools?: boolean };
  onTool?: (info: { tool: string; ok: boolean; preview: string }) => void;
}

export interface RetryInfo {
  attempt: number;
  max: number;
  reasonShort: string;
  delayMs: number;
}

export interface TimingInfo {
  attempt: number;
  elapsedMs: number;
  success: boolean;
}

export interface FailoverState {
  modelHealth: Map<string, AttemptRecord[]>;
}