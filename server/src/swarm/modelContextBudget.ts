// Model-aware context budget scaling.
//
// Different models have vastly different context windows. DeepSeek v4 Flash
// has 1M tokens; smaller models (gemma4) have 8K-32K. This module scales
// file content, repo listings, and transcript history based on the model's
// actual capacity.

export interface ModelContextBudget {
  /** Maximum input tokens for this model */
  maxInputTokens: number;
  /** Whether to show full file content instead of windowed */
  fullFileMode: boolean;
  /** Max repo file paths to include */
  maxRepoFiles: number;
  /** Max README chars */
  maxReadmeChars: number;
  /** Max auditor file state chars */
  maxFileStateChars: number;
  /** Max transcript context items */
  maxTranscriptItems: number;
}

const MODEL_BUDGETS: Record<string, ModelContextBudget> = {
  // Large context models (1M+)
  "deepseek-v4-flash:cloud": {
    maxInputTokens: 1_000_000,
    fullFileMode: true,
    maxRepoFiles: 500,
    maxReadmeChars: 20_000,
    maxFileStateChars: 500_000,
    maxTranscriptItems: 200,
  },
  "deepseek-v4-pro:cloud": {
    maxInputTokens: 1_000_000,
    fullFileMode: true,
    maxRepoFiles: 500,
    maxReadmeChars: 20_000,
    maxFileStateChars: 500_000,
    maxTranscriptItems: 200,
  },
  // Medium context models (128K)
  "glm-5.1:cloud": {
    maxInputTokens: 128_000,
    fullFileMode: false,
    maxRepoFiles: 150,
    maxReadmeChars: 8_000,
    maxFileStateChars: 120_000,
    maxTranscriptItems: 80,
  },
  "glm-5.2:cloud": {
    maxInputTokens: 128_000,
    fullFileMode: false,
    maxRepoFiles: 150,
    maxReadmeChars: 8_000,
    maxFileStateChars: 120_000,
    maxTranscriptItems: 80,
  },
  "nemotron-3-super:cloud": {
    maxInputTokens: 128_000,
    fullFileMode: false,
    maxRepoFiles: 150,
    maxReadmeChars: 8_000,
    maxFileStateChars: 120_000,
    maxTranscriptItems: 80,
  },
};

// Default budget for unknown models — conservative windowed mode
const DEFAULT_BUDGET: ModelContextBudget = {
  maxInputTokens: 32_000,
  fullFileMode: false,
  maxRepoFiles: 150,
  maxReadmeChars: 4_000,
  maxFileStateChars: 60_000,
  maxTranscriptItems: 40,
};

/**
 * Get the context budget for a model. Falls back to conservative defaults
 * for unknown models.
 */
export function getModelBudget(model?: string): ModelContextBudget {
  if (!model) return DEFAULT_BUDGET;
  // Try exact match first, then strip provider prefix
  return MODEL_BUDGETS[model] ?? DEFAULT_BUDGET;
}
