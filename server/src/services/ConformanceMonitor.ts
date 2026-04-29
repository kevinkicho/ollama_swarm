// #295 (2026-04-28): live directive-conformance gauge.
//
// During a run with a non-empty userDirective, polls the local Ollama
// install every CONFORMANCE_INTERVAL_MS (default 90s) with a small
// "rate 0–100 how on-topic is this excerpt?" prompt against the most
// recent transcript text. Emits a `conformance_sample` SwarmEvent
// per successful poll for the UI sparkline.
//
// Two rationales for an in-process monitor (vs running in the worker
// or as a separate service):
//   1. We already have the transcript via runner.status() — no extra
//      plumbing or buffer subscription needed.
//   2. We're emitting via the same opts.emit channel as every other
//      SwarmEvent — the WS path and reconnection-replay logic already
//      handle delivery, no new transport surface.
//
// Cost: one LLM call per poll. For a 15-min run with 90s polling
// that's ~10 calls — small fraction of a typical run's token budget.
//
// Failure modes (all silent — never throws into the runner loop):
//   - Ollama unreachable → skip this poll, try again next interval
//   - Score-JSON malformed → skip
//   - Previous poll still in flight → skip (avoids piling up calls
//     when the grader model is slow)
//   - Empty / very short transcript → skip (nothing to grade)

import type { SwarmEvent, TranscriptEntry } from "../types.js";

export interface ConformanceMonitorOpts {
  runId: string;
  /** Trimmed user directive. Caller guarantees non-empty (don't
   *  instantiate the monitor for runs without a directive). */
  directive: string;
  /** Ollama base URL — strip /v1 if present, we hit /api/chat. */
  ollamaBaseUrl: string;
  /** Model id to use as the grader. Cheap fast models work best
   *  (gemma4:31b-cloud, nemotron-3-super:cloud). Defaults to whatever
   *  the run's main model is. */
  graderModel: string;
  /** Poll interval in ms. Default 90_000. */
  intervalMs?: number;
  /** Max chars of transcript text to send to the grader per poll.
   *  Walks back from the most recent entry until budget. Default 3_000. */
  excerptCharBudget?: number;
  /** Pull the live transcript at poll time. Must be cheap. */
  getTranscript: () => readonly TranscriptEntry[];
  /** Emit a SwarmEvent — typically routed through the broadcaster. */
  emit: (ev: SwarmEvent) => void;
  /** #295 fix: optional liveness check. When supplied, the monitor
   *  self-stops on the first poll where isActive() returns false.
   *  Workaround for the discussion-runner pattern where runner.start()
   *  returns BEFORE the run finishes (`void this.loop()`), making the
   *  orchestrator's finally{} fire monitor.stop() too early. With
   *  isActive bound, the monitor outlives runner.start() and only
   *  cleans up when the run actually ends. */
  isActive?: () => boolean;
  /** Optional override for the underlying fetch — tests inject a stub. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_INTERVAL_MS = 90_000;
const DEFAULT_EXCERPT_BUDGET = 3_000;
const SMOOTHING_WINDOW = 3;
const REQUEST_TIMEOUT_MS = 60_000;

export class ConformanceMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private readonly rawScores: number[] = [];
  private stopped = false;
  private inflight = false;

  constructor(private readonly opts: ConformanceMonitorOpts) {}

  /** Begin polling. First poll fires after `intervalMs` so the run has
   *  some transcript to grade against. */
  start(): void {
    if (this.timer || this.stopped) return;
    const ms = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.poll();
    }, ms);
  }

  /** Stop polling. Idempotent. Safe to call from finally{} on run end. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run a single poll — exposed for tests so they can advance the
   *  loop manually instead of waiting on real timers. */
  async pollOnce(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.inflight) return;
    // Self-stop when the run is no longer active. The orchestrator's
    // start() returns BEFORE discussion runners' loops finish (`void
    // this.loop()` fire-and-forget), so we can't tie our lifecycle
    // to start()'s return. isActive() is bound to runner.isRunning()
    // by the orchestrator — when the runner's loop ends naturally,
    // we self-clean.
    if (this.opts.isActive && !this.opts.isActive()) {
      this.stop();
      return;
    }
    const transcript = this.opts.getTranscript();
    const excerpt = buildExcerpt(
      transcript,
      this.opts.excerptCharBudget ?? DEFAULT_EXCERPT_BUDGET,
    );
    if (excerpt.length === 0) return;

    this.inflight = true;
    const requestStart = Date.now();
    try {
      const result = await gradeWithOllama({
        directive: this.opts.directive,
        excerpt,
        baseUrl: this.opts.ollamaBaseUrl,
        model: this.opts.graderModel,
        fetchImpl: this.opts.fetchImpl ?? fetch,
      });
      if (this.stopped) return;
      const latencyMs = Date.now() - requestStart;
      this.rawScores.push(result.score);
      if (this.rawScores.length > SMOOTHING_WINDOW) this.rawScores.shift();
      const smoothed = Math.round(
        this.rawScores.reduce((a, b) => a + b, 0) / this.rawScores.length,
      );
      this.opts.emit({
        type: "conformance_sample",
        runId: this.opts.runId,
        ts: Date.now(),
        score: result.score,
        smoothedScore: smoothed,
        // #301 Phase A: enrich the per-sample event with metadata
        // the UI infographic surfaces in the tooltip. Lets the user
        // see WHAT generated the score, not just the score itself.
        graderModel: this.opts.graderModel,
        latencyMs,
        excerptChars: excerpt.length,
        windowScores: this.rawScores.slice(),
        ...(result.reason ? { reason: result.reason } : {}),
      });
    } catch {
      // silent — transient grader failures shouldn't pollute the
      // event stream. Next poll tries again.
    } finally {
      this.inflight = false;
    }
  }
}

/** Build a recent-transcript excerpt by walking entries from newest to
 *  oldest and accumulating their `text` field until the char budget
 *  is exhausted. Skips entries with empty text. Joins with a divider
 *  the grader can use to spot turn boundaries.
 *
 *  Exported for tests. */
export function buildExcerpt(
  entries: readonly TranscriptEntry[],
  maxChars: number,
): string {
  const parts: string[] = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const text = (e.text ?? "").trim();
    if (text.length === 0) continue;
    parts.unshift(text);
    total += text.length;
    if (total >= maxChars) break;
  }
  return parts.join("\n---\n");
}

/** Send the grading prompt to Ollama and parse the JSON response.
 *  Throws on any failure (caller swallows). Exported for tests. */
export async function gradeWithOllama(input: {
  directive: string;
  excerpt: string;
  baseUrl: string;
  model: string;
  fetchImpl: typeof fetch;
}): Promise<{ score: number; reason: string | null }> {
  const prompt = `You are a strict grader. Rate 0-100 how on-topic the multi-agent transcript excerpt is to the user's directive.

100 = transcript is making concrete progress toward the directive
50 = mixed/tangential — some discussion is on-topic, some has wandered
0 = transcript has completely drifted away from the directive

Directive: "${input.directive}"

Recent transcript excerpt:
${input.excerpt}

Respond ONLY with valid JSON of shape {"score": <0-100 integer>, "reason": "<one sentence ≤200 chars>"}.`;

  const url = input.baseUrl.replace(/\/v1\/?$/, "") + "/api/chat";
  const r = await input.fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      format: "json",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Ollama /api/chat returned HTTP ${r.status}`);
  const body = (await r.json()) as { message?: { content?: string } };
  const content = body.message?.content?.trim() ?? "";
  if (content.length === 0) throw new Error("Ollama returned empty content");
  // glm-5.1 sometimes wraps JSON in ```json...``` fences despite the
  // format:"json" hint. Strip the fences before parsing — common
  // grader-robustness pattern (RAGAs/LangSmith do the same).
  const stripped = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const parsed = JSON.parse(stripped) as { score?: unknown; reason?: unknown };
  const rawScore = Number(parsed.score);
  if (!Number.isFinite(rawScore)) throw new Error(`Score not numeric: ${parsed.score}`);
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const reasonStr =
    typeof parsed.reason === "string" && parsed.reason.length > 0
      ? parsed.reason.slice(0, 200)
      : null;
  return { score, reason: reasonStr };
}
