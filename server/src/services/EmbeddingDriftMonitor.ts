// #302 Phase B: embedding-similarity drift monitor.
//
// Independent second signal alongside ConformanceMonitor's LLM-judge.
// At run start: embed the directive once. Every poll: embed the most
// recent transcript excerpt + compute cosine similarity to the
// directive. The score (0-100) is "how semantically close is the
// recent conversation to what the user asked for."
//
// Why a separate signal: LLM-judge can be biased by the model's own
// preferences (it grades; another agent in the same family wrote the
// transcript). Embedding similarity is a different family of
// measurement — pure vector geometry. Agreement between the two
// signals = high confidence in drift. Disagreement = noisy data.
//
// Failure mode: if the embedding model isn't pulled (the typical
// case on a fresh Ollama install), the directive embed call fails.
// The monitor logs once + no-ops for the rest of the run. The UI
// tooltip surfaces a "pull <model> to enable" hint when conformance
// samples land but drift samples don't.
//
// Default model: nomic-embed-text (small, fast, widely available).
// User can pull via `ollama pull nomic-embed-text`.

import type { SwarmEvent, TranscriptEntry } from "../types.js";
import { buildExcerpt } from "./ConformanceMonitor.js";

export interface EmbeddingDriftMonitorOpts {
  runId: string;
  /** The user directive — embedded once at start. Must be non-empty. */
  directive: string;
  /** Ollama base URL (no /v1 suffix). We POST to /api/embed. */
  ollamaBaseUrl: string;
  /** Embedding model to use. Default "nomic-embed-text". */
  embeddingModel?: string;
  /** Poll interval in ms. Default 90_000 (matches ConformanceMonitor). */
  intervalMs?: number;
  /** Max chars of transcript text to embed per poll. Default 3_000. */
  excerptCharBudget?: number;
  /** Pull the live transcript. Must be cheap. */
  getTranscript: () => readonly TranscriptEntry[];
  /** Emit a SwarmEvent — typically routed through the broadcaster. */
  emit: (ev: SwarmEvent) => void;
  /** Self-stop signal. Bound to runner.isRunning() by the caller. */
  isActive?: () => boolean;
  /** Optional override for the underlying fetch — tests inject a stub. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_INTERVAL_MS = 90_000;
const DEFAULT_EXCERPT_BUDGET = 3_000;
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const SMOOTHING_WINDOW = 3;
const REQUEST_TIMEOUT_MS = 30_000;

export class EmbeddingDriftMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private readonly rawSimilarities: number[] = [];
  private stopped = false;
  private inflight = false;
  /** The directive's embedding vector. Computed once at start();
   *  null when the embed call failed (graceful no-op). */
  private directiveVec: number[] | null = null;
  /** True when the embedding model is unavailable — we stop trying
   *  after the first failure to avoid spamming Ollama with bad calls. */
  private modelUnavailable = false;

  constructor(private readonly opts: EmbeddingDriftMonitorOpts) {}

  /** Compute the directive embedding + start polling. If the embed
   *  call fails (model not pulled, etc.), the monitor enters
   *  no-op mode — no events emitted, no further attempts. */
  async start(): Promise<void> {
    if (this.timer || this.stopped) return;
    try {
      this.directiveVec = await embedText({
        text: this.opts.directive,
        baseUrl: this.opts.ollamaBaseUrl,
        model: this.opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
        fetchImpl: this.opts.fetchImpl ?? fetch,
      });
    } catch {
      // Model not pulled or Ollama down — enter no-op mode.
      this.modelUnavailable = true;
      this.directiveVec = null;
      return;
    }
    if (!this.directiveVec || this.directiveVec.length === 0) {
      this.modelUnavailable = true;
      return;
    }
    const ms = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.poll();
    }, ms);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Test hook — synchronous poll trigger. */
  async pollOnce(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.inflight || this.modelUnavailable) return;
    if (this.opts.isActive && !this.opts.isActive()) {
      this.stop();
      return;
    }
    if (!this.directiveVec) return;

    const transcript = this.opts.getTranscript();
    const excerpt = buildExcerpt(
      transcript,
      this.opts.excerptCharBudget ?? DEFAULT_EXCERPT_BUDGET,
    );
    if (excerpt.length === 0) return;

    this.inflight = true;
    try {
      const transcriptVec = await embedText({
        text: excerpt,
        baseUrl: this.opts.ollamaBaseUrl,
        model: this.opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
        fetchImpl: this.opts.fetchImpl ?? fetch,
      });
      if (this.stopped) return;
      const sim = cosineSimilarity(this.directiveVec, transcriptVec);
      // Map cosine similarity (-1..1) → 0..100 score where 100 = identical.
      // For typical text, real-world cosine on different topics is 0.3-0.7;
      // same topic is 0.7-0.95. Linear map keeps the math simple.
      const similarity = Math.round(Math.max(0, Math.min(1, (sim + 1) / 2)) * 100);
      this.rawSimilarities.push(similarity);
      if (this.rawSimilarities.length > SMOOTHING_WINDOW) this.rawSimilarities.shift();
      const smoothedSimilarity = Math.round(
        this.rawSimilarities.reduce((a, b) => a + b, 0) / this.rawSimilarities.length,
      );
      this.opts.emit({
        type: "drift_sample",
        runId: this.opts.runId,
        ts: Date.now(),
        similarity,
        smoothedSimilarity,
        embeddingModel: this.opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
        excerptChars: excerpt.length,
        windowSimilarities: this.rawSimilarities.slice(),
      });
    } catch {
      // silent — transient embedding failures shouldn't pollute the
      // event stream. Next poll tries again. A persistent failure
      // would turn into an infinite no-op cycle, but the cost per
      // poll is low (single HTTP call).
    } finally {
      this.inflight = false;
    }
  }
}

/** Embed a string via Ollama's /api/embed endpoint. Returns the
 *  embedding vector. Throws on HTTP error or missing field.
 *  Exported for tests. */
export async function embedText(input: {
  text: string;
  baseUrl: string;
  model: string;
  fetchImpl: typeof fetch;
}): Promise<number[]> {
  const url = input.baseUrl.replace(/\/v1\/?$/, "") + "/api/embed";
  const r = await input.fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      input: input.text,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Ollama /api/embed returned HTTP ${r.status}`);
  const body = (await r.json()) as { embeddings?: number[][]; embedding?: number[] };
  // Ollama returns either { embeddings: [[...]] } (newer batch shape)
  // or { embedding: [...] } (older single-input shape). Handle both.
  const vec = body.embeddings?.[0] ?? body.embedding;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error("Ollama /api/embed returned no embedding");
  }
  return vec;
}

/** Cosine similarity of two vectors. Returns -1..1. Exported for tests.
 *  Throws when vectors have different dimensions or are empty. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`vector dim mismatch: a=${a.length} b=${b.length}`);
  }
  if (a.length === 0) throw new Error("empty vectors");
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  const denom = Math.sqrt(aMag) * Math.sqrt(bMag);
  if (denom === 0) return 0;
  return dot / denom;
}
