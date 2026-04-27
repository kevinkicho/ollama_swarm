// Task #133: thin HTTP proxy in front of Ollama. Lets us capture
// `prompt_eval_count` + `eval_count` from every Ollama response (which
// the OpenCode SDK strips before returning to runners). Aggregates
// per-window totals for the usage dashboard.
//
// Why a proxy instead of intercepting OpenCode's calls:
//   - OpenCode's SDK sits on top of an HTTP layer we don't control.
//   - Stripping happens before any callback we have.
//   - The cleanest non-fork solution is to put ourselves between
//     OpenCode and Ollama and snoop the responses.
//
// Streaming-aware: Ollama supports SSE for /v1/chat/completions and
// JSONL for /api/generate stream=true. The proxy tee's the response
// body to the client AND captures it for parsing. After end, we look
// for usage in:
//   - Top-level keys: prompt_eval_count + eval_count (Ollama-native)
//   - usage.{prompt_tokens, completion_tokens} (OpenAI-compat)
//   - In streamed payloads: typically only the LAST chunk includes
//     usage (when stream_options.include_usage=true) — we scan all
//     SSE / JSONL frames.
//
// Bounded memory: we keep the LATEST CACHE_LIMIT records. Older ones
// drop. Window queries iterate in-memory; for a 7-day window with
// ~1 call/sec that's 600k records ≈ 60MB, plenty of headroom.

import { createServer, request as httpRequest } from "node:http";
import { URL } from "node:url";

export interface UsageRecord {
  ts: number;
  promptTokens: number;
  responseTokens: number;
  durationMs: number;
  model?: string;
  /** path the proxy received (e.g. "/v1/chat/completions" or "/api/generate"). */
  path?: string;
  /** Active preset at the time of the call. The app enforces single-run-
   *  at-a-time, so every call during a run is attributable to that run's
   *  preset; orchestrator pushes the current preset into the tracker on
   *  run-start / run-end via setCurrentPreset(). Null between runs. */
  preset?: string;
}

export interface UsageWindow {
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
  calls: number;
  windowMs: number;
  windowLabel: string;
  /** Per-model breakdown — `model name → { promptTokens, responseTokens, calls }`. */
  byModel: Record<string, { promptTokens: number; responseTokens: number; calls: number }>;
  /** Per-preset breakdown — `preset id → { promptTokens, responseTokens, calls }`.
   *  Calls between runs (no active preset) bucket as "(idle)". */
  byPreset: Record<string, { promptTokens: number; responseTokens: number; calls: number }>;
}

const CACHE_LIMIT = 100_000;

// Task #137: quota-exhausted state. When the proxy sees an upstream
// Ollama response that signals the account is at its rate / usage
// wall (HTTP 429, sometimes 402/403 with a quota-shaped body), it
// flips this state. Runners poll isQuotaExhausted() between turns
// and stop the run cleanly with a "cap:quota" reason — no point
// burning the rest of the round on retries the proxy will keep
// rejecting. Orchestrator clears the state on run-start so the
// NEXT run gets to discover the wall fresh (e.g. after a sleep
// past the rate window).
export interface QuotaState {
  since: number;
  reason: string;
  statusCode: number;
  // Task #149: distinguishes transient (concurrency burst that clears in
  // seconds) from persistent (plan/usage/rate-window wall that needs
  // intervention). Runners should halt only on "persistent"; "transient"
  // is informational only — the SDK's per-call retry handles the back-off.
  kind: "transient" | "persistent";
}

// Persistent wall — plan / usage / weekly / monthly quota. These need
// human or rate-window intervention; the run should halt cleanly.
const QUOTA_PERSISTENT_KEYWORDS: readonly RegExp[] = [
  /\bquota\b/i,
  /\busage[\s_-]*limit/i,
  /\bweekly[\s_-]*limit/i,
  /\bmonthly[\s_-]*limit/i,
  /\bplan[\s_-]*limit/i,
  /\bexceed(?:ed|s)?\s+(?:your\s+)?(?:plan|quota|limit)/i,
];
// Transient wall — concurrency / rate-burst / capacity. These clear
// in seconds-to-minutes; the SDK's retry-with-backoff handles them.
// We still record the event so the UI can show "throttled briefly"
// but the run keeps going.
// 2026-04-27: added "overloaded" + "server overloaded" + "503" after
// run 59c66144 crashed on
//   "Ollama HTTP 503: Server overloaded, please retry shortly"
// Crashing on a transient capacity hiccup wastes the whole run.
const QUOTA_TRANSIENT_KEYWORDS: readonly RegExp[] = [
  /\bconcurrent\b/i,
  /\b(too\s+many\s+requests)\b/i,
  /\brate[\s_-]*limit(?:ed)?/i,
  /\boverloaded\b/i,
  /\bserver\s+busy\b/i,
];

function classifyQuotaKind(body: string): "transient" | "persistent" {
  // Persistent takes precedence — a body that mentions both ("rate limit
  // on your plan") is a real quota wall, not a burst.
  if (QUOTA_PERSISTENT_KEYWORDS.some((re) => re.test(body))) return "persistent";
  if (QUOTA_TRANSIENT_KEYWORDS.some((re) => re.test(body))) return "transient";
  // Empty/unclassifiable body on a 429 — assume persistent (safer to
  // halt than to spin if we can't tell).
  return "persistent";
}

// Backward-compat alias — anywhere we used QUOTA_BODY_KEYWORDS we now
// match either category. Used by detectQuotaExhausted for 402/403 and
// 200-with-error paths where any quota-shaped signal is enough to flag.
const QUOTA_BODY_KEYWORDS: readonly RegExp[] = [
  ...QUOTA_PERSISTENT_KEYWORDS,
  ...QUOTA_TRANSIENT_KEYWORDS,
];

class TokenTracker {
  private records: UsageRecord[] = [];
  private currentPreset?: string;
  private quota: QuotaState | null = null;

  add(r: UsageRecord): void {
    // Stamp current preset at insertion time; the orchestrator owns
    // setCurrentPreset across run boundaries.
    if (this.currentPreset && !r.preset) {
      r = { ...r, preset: this.currentPreset };
    }
    this.records.push(r);
    if (this.records.length > CACHE_LIMIT) {
      this.records.splice(0, this.records.length - CACHE_LIMIT);
    }
  }

  /** Called from Orchestrator on run start / end. */
  setCurrentPreset(preset: string | undefined): void {
    this.currentPreset = preset;
  }

  /** Task #137: proxy flips this when upstream Ollama returns a quota-
   *  shaped response. Runners poll between turns; UI surfaces the wall.
   *  Task #149: now also tracks kind ("transient" concurrency vs
   *  "persistent" plan-quota). Persistent walls win if both have been
   *  observed in the same run — once a real quota is hit, downgrading
   *  back to "transient" would be misleading. */
  markQuotaExhausted(statusCode: number, reason: string, kind: "transient" | "persistent" = "persistent"): void {
    if (this.quota) {
      // Upgrade transient → persistent if we see a worse signal later.
      if (this.quota.kind === "transient" && kind === "persistent") {
        this.quota = { ...this.quota, statusCode, reason, kind };
      }
      return;
    }
    this.quota = { since: Date.now(), reason, statusCode, kind };
  }

  /** Cleared on run-start so the next run can probe the wall fresh. */
  clearQuotaState(): void {
    this.quota = null;
  }

  isQuotaExhausted(): boolean {
    return this.quota !== null;
  }

  /** Task #149: only returns true for persistent walls. Runners use this
   *  for halt decisions; transient bursts shouldn't abort the run. */
  shouldHaltOnQuota(): boolean {
    return this.quota !== null && this.quota.kind === "persistent";
  }

  getQuotaState(): QuotaState | null {
    return this.quota;
  }

  totalsInWindow(windowMs: number, label: string): UsageWindow {
    const cutoff = Date.now() - windowMs;
    let p = 0;
    let r = 0;
    let c = 0;
    const byModel: Record<string, { promptTokens: number; responseTokens: number; calls: number }> = {};
    const byPreset: Record<string, { promptTokens: number; responseTokens: number; calls: number }> = {};
    for (const rec of this.records) {
      if (rec.ts < cutoff) continue;
      p += rec.promptTokens;
      r += rec.responseTokens;
      c += 1;
      const mKey = rec.model ?? "(unknown)";
      const m = byModel[mKey] ?? { promptTokens: 0, responseTokens: 0, calls: 0 };
      m.promptTokens += rec.promptTokens;
      m.responseTokens += rec.responseTokens;
      m.calls += 1;
      byModel[mKey] = m;
      const pKey = rec.preset ?? "(idle)";
      const pp = byPreset[pKey] ?? { promptTokens: 0, responseTokens: 0, calls: 0 };
      pp.promptTokens += rec.promptTokens;
      pp.responseTokens += rec.responseTokens;
      pp.calls += 1;
      byPreset[pKey] = pp;
    }
    return {
      promptTokens: p,
      responseTokens: r,
      totalTokens: p + r,
      calls: c,
      windowMs,
      windowLabel: label,
      byModel,
      byPreset,
    };
  }

  /** Latest N records — used by the UI to render a recent-calls table. */
  recent(n: number): readonly UsageRecord[] {
    if (this.records.length <= n) return [...this.records];
    return this.records.slice(-n);
  }

  /** Total tokens since process start. Cheap "lifetime" counter for the
   *  status endpoint. */
  total(): { promptTokens: number; responseTokens: number; calls: number } {
    let p = 0;
    let r = 0;
    for (const rec of this.records) {
      p += rec.promptTokens;
      r += rec.responseTokens;
    }
    return { promptTokens: p, responseTokens: r, calls: this.records.length };
  }

  /** Task #169: lifetime totals including the same byModel + byPreset
   *  breakdowns that totalsInWindow() produces, so the UI's usage
   *  widget can offer an "All time" toggle next to the existing
   *  "Last 24h" view. Iterates all in-memory records (capped at
   *  CACHE_LIMIT = 100k — for our scale, equivalent to lifetime). */
  totalsAllTime(label: string = "lifetime"): UsageWindow {
    let p = 0;
    let r = 0;
    let c = 0;
    const byModel: Record<string, { promptTokens: number; responseTokens: number; calls: number }> = {};
    const byPreset: Record<string, { promptTokens: number; responseTokens: number; calls: number }> = {};
    for (const rec of this.records) {
      p += rec.promptTokens;
      r += rec.responseTokens;
      c += 1;
      const mKey = rec.model ?? "(unknown)";
      const m = byModel[mKey] ?? { promptTokens: 0, responseTokens: 0, calls: 0 };
      m.promptTokens += rec.promptTokens;
      m.responseTokens += rec.responseTokens;
      m.calls += 1;
      byModel[mKey] = m;
      const pKey = rec.preset ?? "(idle)";
      const pp = byPreset[pKey] ?? { promptTokens: 0, responseTokens: 0, calls: 0 };
      pp.promptTokens += rec.promptTokens;
      pp.responseTokens += rec.responseTokens;
      pp.calls += 1;
      byPreset[pKey] = pp;
    }
    return {
      promptTokens: p,
      responseTokens: r,
      totalTokens: p + r,
      calls: c,
      windowMs: Number.POSITIVE_INFINITY,
      windowLabel: label,
      byModel,
      byPreset,
    };
  }

  /** Task #124: total tokens (prompt + response) since the given
   *  lifetime baseline. Runners snapshot baseline at run-start and
   *  poll this every cap-check to know how many tokens THIS run has
   *  consumed (vs lifetime totals which include prior runs). */
  totalSinceLifetimeBaseline(baseline: number): number {
    const t = this.total();
    return t.promptTokens + t.responseTokens - baseline;
  }
}

/** Task #124: snapshot helper — runner calls at run-start to capture
 *  the lifetime token total. Subsequent checks compare against this. */
export function snapshotLifetimeTokens(): number {
  const t = tokenTracker.total();
  return t.promptTokens + t.responseTokens;
}

/** Task #124: returns true if the current run has consumed more
 *  tokens than its budget. Returns false when no budget set. */
export function tokenBudgetExceeded(baseline: number, budget: number | undefined): boolean {
  if (!budget || budget <= 0) return false;
  return tokenTracker.totalSinceLifetimeBaseline(baseline) >= budget;
}

/** Task #137: convenience export — runners poll between turns. Returns
 *  true once the proxy has seen a quota-shaped upstream response since
 *  the last clearQuotaState() call. NOTE: this returns true for BOTH
 *  transient and persistent walls. For halt decisions, runners should
 *  prefer shouldHaltOnQuota() (Task #149). isQuotaExhausted is kept
 *  for back-compat but flagged so callers think about the distinction. */
export function isQuotaExhausted(): boolean {
  return tokenTracker.isQuotaExhausted();
}

/** Task #149: runners should call this in cap-checks, not isQuotaExhausted.
 *  Only returns true for persistent walls (plan / usage / weekly limit).
 *  Transient concurrency-429s clear in seconds via SDK retry; halting
 *  on them aborts otherwise-healthy runs. */
export function shouldHaltOnQuota(): boolean {
  return tokenTracker.shouldHaltOnQuota();
}

/** Task #137: pure detector — exported for unit tests. Decides whether
 *  an upstream Ollama response (status code + body) is signaling that
 *  the account is at its rate / usage wall. Returns the reason string
 *  on detection; null otherwise. */
export function detectQuotaExhausted(status: number, body: string): string | null {
  // Status 429 is the textbook signal — Ollama Cloud uses it for
  // rate-limit AND for plan-quota walls. 402/403 with quota body are
  // rarer but seen in some upstream variants.
  if (status === 429) {
    return body.length > 0 ? `429 ${truncateForReason(body)}` : "429 Too Many Requests";
  }
  if (status === 402 || status === 403) {
    if (QUOTA_BODY_KEYWORDS.some((re) => re.test(body))) {
      return `${status} ${truncateForReason(body)}`;
    }
  }
  // 2026-04-27: HTTP 503 with quota-shaped body (typically "Server
  // overloaded" from Ollama Cloud during capacity spikes). Transient —
  // the run should pause + probe instead of crashing. See
  // run 59c66144 crash post-mortem.
  if (status === 503) {
    if (QUOTA_BODY_KEYWORDS.some((re) => re.test(body))) {
      return `503 ${truncateForReason(body)}`;
    }
  }
  // Some upstream variants return 200 with an error body (no usage
  // counts, just an "error" field naming the quota). Catch those too —
  // requires a JSON-shaped error field that mentions a quota keyword.
  if (status === 200 && body.length < 4_000) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object") {
        const err = (parsed as { error?: unknown }).error;
        if (typeof err === "string" && QUOTA_BODY_KEYWORDS.some((re) => re.test(err))) {
          return `200-with-error: ${truncateForReason(err)}`;
        }
      }
    } catch {
      // body wasn't JSON; fine — fall through (probably a normal SSE chunk).
    }
  }
  return null;
}

function detectAndMarkQuotaExhausted(status: number, body: string): void {
  const reason = detectQuotaExhausted(status, body);
  if (reason) {
    const kind = classifyQuotaKind(body);
    tokenTracker.markQuotaExhausted(status, reason, kind);
  }
}

function truncateForReason(s: string, max = 160): string {
  const cleaned = s.trim().replace(/\s+/g, " ");
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export const tokenTracker = new TokenTracker();

interface ProxyOpts {
  /** Port the proxy listens on (we'll point opencode here). */
  listenPort: number;
  /** Real Ollama base URL we forward to (e.g. http://localhost:11434). */
  upstreamUrl: string;
}

export function startOllamaProxy(opts: ProxyOpts): { stop: () => Promise<void> } {
  const upstream = new URL(opts.upstreamUrl);
  const upstreamHost = upstream.hostname;
  const upstreamPort = upstream.port ? Number(upstream.port) : (upstream.protocol === "https:" ? 443 : 80);

  const server = createServer((req, res) => {
    const t0 = Date.now();
    const reqPath = req.url ?? "/";
    // Strip our own host header so upstream sees its own hostname.
    const headers = { ...req.headers };
    delete headers.host;

    const proxyReq = httpRequest(
      {
        hostname: upstreamHost,
        port: upstreamPort,
        path: reqPath,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        // Pass status + headers straight through.
        const status = proxyRes.statusCode ?? 200;
        res.writeHead(status, proxyRes.headers);
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          res.write(chunk);
        });
        proxyRes.on("end", () => {
          res.end();
          // Best-effort token capture — failures are silent so a parse
          // glitch never breaks the actual proxied response.
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            // Task #137: scan for quota-exhausted signals BEFORE token
            // recording so a 429-with-no-tokens correctly flips the
            // wall flag. Cheap (regex scan on a string we'd parse
            // anyway).
            detectAndMarkQuotaExhausted(status, body);
            recordTokensFromBody(body, {
              ts: Date.now(),
              durationMs: Date.now() - t0,
              path: reqPath,
            });
          } catch {
            // ignore
          }
        });
      },
    );
    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end(`ollama-proxy upstream error: ${err.message}`);
    });
    req.pipe(proxyReq);
  });

  server.listen(opts.listenPort, "127.0.0.1");

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface RecordCtx {
  ts: number;
  durationMs: number;
  path: string;
}

function recordTokensFromBody(body: string, ctx: RecordCtx): void {
  if (!body) return;
  // Strategy 1: single JSON response (non-streaming).
  const trimmed = body.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const parsed = tryParseJson(trimmed);
    if (parsed) {
      const rec = extractTokens(parsed, ctx);
      if (rec) tokenTracker.add(rec);
      return;
    }
  }
  // Strategy 2: SSE stream — lines beginning with "data:" carry JSON.
  // Strategy 3: JSONL stream — newline-delimited JSON objects.
  // Both handled by scanning every line that looks like JSON; we
  // accumulate the LAST record with non-zero usage (Ollama emits
  // usage in the final chunk only for OpenAI-compat / generate).
  let captured: UsageRecord | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let payload = line;
    if (payload.startsWith("data:")) payload = payload.slice(5).trim();
    if (payload === "[DONE]" || !payload || !payload.startsWith("{")) continue;
    const parsed = tryParseJson(payload);
    if (!parsed) continue;
    const rec = extractTokens(parsed, ctx);
    if (rec) captured = rec;
  }
  if (captured) tokenTracker.add(captured);
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractTokens(obj: unknown, ctx: RecordCtx): UsageRecord | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const usage = (o.usage && typeof o.usage === "object") ? (o.usage as Record<string, unknown>) : null;
  // Ollama-native fields take precedence (most accurate, always present
  // on /api/generate). OpenAI-compat usage block is the fallback.
  const promptTokens = numOrZero(o.prompt_eval_count) || numOrZero(usage?.prompt_tokens);
  const responseTokens = numOrZero(o.eval_count) || numOrZero(usage?.completion_tokens);
  if (promptTokens === 0 && responseTokens === 0) return null;
  return {
    ts: ctx.ts,
    durationMs: ctx.durationMs,
    promptTokens,
    responseTokens,
    model: typeof o.model === "string" ? o.model : undefined,
    path: ctx.path,
  };
}

function numOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
