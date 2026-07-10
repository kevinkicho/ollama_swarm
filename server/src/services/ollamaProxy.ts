// Thin HTTP proxy in front of Ollama (especially Ollama Cloud) for:
// - Token usage capture (prompt_eval_count/eval_count or usage.*)
// - Per-run attribution (critical for concurrent + Brain)
// - Quota detection (429 + plan limits)
//
// Hardened for stability:
// - Incremental streaming parsing (no full-body buffer for usage)
// - Bounded in-memory records (ring-buffer style)
// - runId propagated via X-Swarm-Run-Id header for clean isolation
// - Best-effort, never breaks the actual request/response
//
// Set OLLAMA_PROXY_PORT=0 to disable (only for pure local Ollama where you
// don't need central tracking/quota).

import { createServer, request as httpRequest } from "node:http";
import { URL } from "node:url";
import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectSummaryTokenRows,
  summaryRowsToUsageRecords,
} from "./usageFromRunSummaries.js";

export interface UsageRecord {
  ts: number;
  promptTokens: number;
  responseTokens: number;
  durationMs: number;
  model?: string;
  /** path the proxy received (e.g. "/v1/chat/completions" or "/api/generate"). */
  path?: string;
  /** Active preset at the time of the call (orchestrator pushes on run-start/end). */
  preset?: string;
  /** Run ID for per-run attribution. Null for calls outside a run. */
  runId?: string;
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

// #239 (2026-04-28): persist token-usage records across dev-server
// restarts. Append-only JSONL — one record per line, dropped on prune
// when the file exceeds PERSIST_PRUNE_MAX_BYTES. Stored in tmpdir so
// it survives `npm run dev` cycles but resets cleanly on host reboot.
//
// Format: each line is a JSON-serialized UsageRecord with ts (ms epoch).
// Old records (older than PERSIST_RETENTION_MS) are filtered at load.
const USAGE_PERSIST_FILE = join(tmpdir(), "ollama-swarm-usage.jsonl");
const PERSIST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PERSIST_PRUNE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
function loadPersistedRecords(): UsageRecord[] {
  if (!existsSync(USAGE_PERSIST_FILE)) return [];
  let raw: string;
  try {
    raw = readFileSync(USAGE_PERSIST_FILE, "utf8");
  } catch {
    return [];
  }
  const cutoff = Date.now() - PERSIST_RETENTION_MS;
  const out: UsageRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as UsageRecord;
      if (typeof obj.ts === "number" && obj.ts >= cutoff) out.push(obj);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}
function appendPersistedRecord(rec: UsageRecord): void {
  try {
    mkdirSync(dirname(USAGE_PERSIST_FILE), { recursive: true });
    appendFileSync(USAGE_PERSIST_FILE, JSON.stringify(rec) + "\n", "utf8");
  } catch {
    // best-effort persistence; in-memory cache still works
  }
}

class TokenTracker {
  // Hydrate from disk on construct so dev-server restarts don't wipe
  // history. Records older than PERSIST_RETENTION_MS are dropped at
  // load time (see loadPersistedRecords).
  private records: UsageRecord[] = loadPersistedRecords();
  private currentPresets = new Map<string, string>();
  private currentPreset: string | undefined;
  /** Legacy global flag — kept for callers without runId attribution. */
  private quota: QuotaState | null = null;
  /** Per-run quota walls (PR-6). Run-scoped halt decisions use this map. */
  private quotaByRun = new Map<string, QuotaState>();
  /** Upstream-wide Ollama quota when proxy cannot attribute a runId. */
  private globalOllamaQuota: QuotaState | null = null;
  /** runIds already ingested from summary JSON backfill (avoid doubles). */
  private summaryBackfillIds = new Set<string>();
  private summaryBackfillDoneFor = "";

  add(r: UsageRecord, runId?: string): void {
    if (runId) r = { ...r, runId };
    if (runId && this.currentPresets.has(runId)) {
      if (!r.preset) r = { ...r, preset: this.currentPresets.get(runId) };
    } else if (this.currentPreset && !r.preset) {
      r = { ...r, preset: this.currentPreset };
    }
    // Never drop a completed call — zero counts still prove traffic existed.
    // When providers omit usage, callers should pass estimateTokens() values.
    this.records.push(r);

    if (this.records.length > CACHE_LIMIT) {
      const overflow = this.records.length - CACHE_LIMIT;
      this.records.splice(0, Math.max(1, Math.floor(overflow * 1.1)));
    }

    appendPersistedRecord(r);

    // Occasional cleanup of very old per-run preset mappings (isolation hygiene)
    if (this.records.length % 500 === 0 && this.currentPresets.size > 32) {
      // Keep only presets for runs that have recent records
      const recentRunIds = new Set(this.records.slice(-200).map(rec => rec.runId).filter(Boolean));
      for (const [rid] of this.currentPresets) {
        if (!recentRunIds.has(rid)) this.currentPresets.delete(rid);
      }
    }
  }

  /** Called from Orchestrator on run start / end. */
  setCurrentPreset(preset: string | undefined, runId?: string): void {
    if (runId) {
      if (preset) this.currentPresets.set(runId, preset);
      else this.currentPresets.delete(runId);
    } else {
      this.currentPreset = preset;
    }
  }


  /** Task #137: proxy flips this when upstream Ollama returns a quota-
   *  shaped response. Runners poll between turns; UI surfaces the wall.
   *  Tracks kind ("transient" vs "persistent"). Persistent wins if seen. */
  private upsertQuota(
    existing: QuotaState | null | undefined,
    statusCode: number,
    reason: string,
    kind: "transient" | "persistent",
  ): QuotaState {
    if (existing) {
      if (existing.kind === "transient" && kind === "persistent") {
        return { ...existing, statusCode, reason, kind };
      }
      return existing;
    }
    return { since: Date.now(), reason, statusCode, kind };
  }

  markQuotaExhausted(
    statusCode: number,
    reason: string,
    kind: "transient" | "persistent" = "persistent",
    runId?: string,
  ): void {
    if (runId) {
      const prev = this.quotaByRun.get(runId);
      this.quotaByRun.set(runId, this.upsertQuota(prev, statusCode, reason, kind));
      return;
    }
    this.globalOllamaQuota = this.upsertQuota(this.globalOllamaQuota, statusCode, reason, kind);
    this.quota = this.globalOllamaQuota;
  }

  /** Cleared on run-start (per runId) or all runs (undefined) on shutdown. */
  clearQuotaState(runId?: string): void {
    if (runId === undefined) {
      this.quota = null;
      this.quotaByRun.clear();
      this.globalOllamaQuota = null;
      return;
    }
    this.quotaByRun.delete(runId);
  }

  isQuotaExhausted(runId?: string): boolean {
    if (runId) return this.quotaByRun.has(runId);
    return this.quota !== null || this.globalOllamaQuota !== null;
  }

  /** Returns true only for persistent quota walls (runners halt on this). */
  shouldHaltOnQuota(runId?: string): boolean {
    if (runId) {
      const q = this.quotaByRun.get(runId);
      return q !== undefined && q.kind === "persistent";
    }
    const g = this.globalOllamaQuota ?? this.quota;
    return g !== null && g.kind === "persistent";
  }

  getQuotaState(runId?: string): QuotaState | null {
    if (runId) return this.quotaByRun.get(runId) ?? null;
    return this.globalOllamaQuota ?? this.quota;
  }

  getGlobalQuotaState(): QuotaState | null {
    return this.globalOllamaQuota ?? this.quota;
  }

  totalsInWindow(windowMs: number, label: string, runId?: string): UsageWindow {
    this.ensureHydratedFromDisk();
    const cutoff = Date.now() - windowMs;
    let p = 0;
    let r = 0;
    let c = 0;
    const byModel: Record<string, { promptTokens: number; responseTokens: number; calls: number }> = {};
    const byPreset: Record<string, { promptTokens: number; responseTokens: number; calls: number }> = {};
    for (const rec of this.records) {
      if (rec.ts < cutoff) continue;
      if (runId && rec.runId !== runId) continue;
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
    this.ensureHydratedFromDisk();
    if (this.records.length <= n) return [...this.records];
    return this.records.slice(-n);
  }

  /** Simple pressure signal for stability dashboards / gateway. */
  pressure(): { recordCount: number; atLimit: boolean; quotaActiveRuns: number } {
    return {
      recordCount: this.records.length,
      atLimit: this.records.length >= CACHE_LIMIT,
      quotaActiveRuns: this.quotaByRun.size,
    };
  }

  /**
   * If memory is empty but the on-disk buffer has rows (server started
   * before any writes, or a race lost the hydrate), reload once.
   */
  ensureHydratedFromDisk(): void {
    if (this.records.length > 0) return;
    const fromDisk = loadPersistedRecords();
    if (fromDisk.length === 0) return;
    this.records = fromDisk;
    // Track summary-backfill runIds already on disk so we don't re-add.
    for (const rec of this.records) {
      if (rec.runId && rec.path?.startsWith("summary-backfill:")) {
        this.summaryBackfillIds.add(rec.runId);
      }
    }
  }

  /**
   * Merge historical totals from run summary JSON under known project
   * parents into the live tracker (deduped by runId). Replaces weaker
   * prior backfill rows (e.g. zero-token skip → estimate) when a larger
   * total is found.
   */
  backfillFromRunSummaries(parentPaths: readonly string[]): {
    added: number;
    updated: number;
    scannedParents: number;
  } {
    this.ensureHydratedFromDisk();
    const roots = [...new Set(parentPaths.filter(Boolean))].sort();
    this.summaryBackfillDoneFor = roots.join("|");

    const rows = collectSummaryTokenRows(roots);
    const records = summaryRowsToUsageRecords(rows);
    let added = 0;
    let updated = 0;
    for (const rec of records) {
      const rid = rec.runId;
      if (!rid) continue;
      const recTotal = rec.promptTokens + rec.responseTokens;
      if (recTotal <= 0) continue;

      // Live stream records (non-summary paths) win if they already dominate.
      const existingLive = this.records.filter(
        (r) => r.runId === rid && !r.path?.startsWith("summary-"),
      );
      if (existingLive.length > 0) {
        const liveTotal = existingLive.reduce((s, r) => s + r.promptTokens + r.responseTokens, 0);
        if (liveTotal >= recTotal) {
          this.summaryBackfillIds.add(rid);
          continue;
        }
      }

      const existingSummaryIdx = this.records.findIndex(
        (r) => r.runId === rid && r.path?.startsWith("summary-"),
      );
      if (existingSummaryIdx >= 0) {
        const prev = this.records[existingSummaryIdx]!;
        const prevTotal = prev.promptTokens + prev.responseTokens;
        if (prevTotal >= recTotal) {
          this.summaryBackfillIds.add(rid);
          continue;
        }
        // Upgrade estimate / weak backfill to better numbers.
        this.records[existingSummaryIdx] = rec;
        this.summaryBackfillIds.add(rid);
        appendPersistedRecord(rec);
        updated += 1;
        continue;
      }

      this.records.push(rec);
      this.summaryBackfillIds.add(rid);
      appendPersistedRecord(rec);
      added += 1;
    }
    if (this.records.length > CACHE_LIMIT) {
      const overflow = this.records.length - CACHE_LIMIT;
      this.records.splice(0, Math.max(1, Math.floor(overflow * 1.1)));
    }
    return { added, updated, scannedParents: roots.length };
  }

  /** Total tokens since process start. Cheap "lifetime" counter for the
   *  status endpoint. */
  total(): { promptTokens: number; responseTokens: number; calls: number } {
    this.ensureHydratedFromDisk();
    let p = 0;
    let r = 0;
    for (const rec of this.records) {
      p += rec.promptTokens;
      r += rec.responseTokens;
    }
    return { promptTokens: p, responseTokens: r, calls: this.records.length };
  }

  /** Lifetime totals (byModel + byPreset) for UI "All time" view. */
  totalsAllTime(label: string = "lifetime"): UsageWindow {
    this.ensureHydratedFromDisk();
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

  /** Phase 2 of #314: every UsageRecord with ts >= sinceMs. The
   *  cost-cap watchdog passes the run's start timestamp; CostTracker
   *  multiplies each record by its (provider, model) price and sums.
   *  Cheap — records are pre-sorted by insertion time, but a linear
   *  scan over CACHE_LIMIT (100k) is fine at the ~5s cap-tick cadence. */
  recordsSinceTs(sinceMs: number): readonly UsageRecord[] {
    const out: UsageRecord[] = [];
    for (const rec of this.records) {
      if (rec.ts >= sinceMs) out.push(rec);
    }
    return out;
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
export function isQuotaExhausted(runId?: string): boolean {
  return tokenTracker.isQuotaExhausted(runId);
}

/** Task #149: runners should call this in cap-checks, not isQuotaExhausted.
 *  Only returns true for persistent walls (plan / usage / weekly limit).
 *  Transient concurrency-429s clear in seconds via SDK retry; halting
 *  on them aborts otherwise-healthy runs. */
export function shouldHaltOnQuota(runId?: string): boolean {
  return tokenTracker.shouldHaltOnQuota(runId);
}

/** Task #137: pure detector — exported for unit tests. Decides whether
 *  an upstream Ollama response (status code + body) is signaling that
 *  the account is at its rate / usage wall. Returns the reason string
 *  on detection; null otherwise. */
export function detectQuotaExhausted(status: number, body: string): string | null {
  const safeBody = body.length > 8000 ? body.slice(0, 8000) : body; // cap for safety

  if (status === 429) {
    return safeBody.length > 0 ? `429 ${truncateForReason(safeBody)}` : "429 Too Many Requests";
  }
  if (status === 402 || status === 403) {
    if (QUOTA_BODY_KEYWORDS.some((re) => re.test(safeBody))) {
      return `${status} ${truncateForReason(safeBody)}`;
    }
  }
  // 503 "overloaded" from Ollama Cloud during capacity (common for :cloud models).
  // Treat as transient unless body strongly indicates persistent quota.
  if (status === 503) {
    const isPersistent = QUOTA_PERSISTENT_KEYWORDS.some((re) => re.test(safeBody));
    if (isPersistent || QUOTA_BODY_KEYWORDS.some((re) => re.test(safeBody))) {
      const kind = isPersistent ? "persistent" : "transient";
      return `503${kind === "persistent" ? "-quota" : ""} ${truncateForReason(safeBody)}`;
    }
  }
  if (status === 200 && safeBody.length < 4000) {
    try {
      const parsed = JSON.parse(safeBody);
      if (parsed && typeof parsed === "object") {
        const err = (parsed as { error?: unknown }).error;
        if (typeof err === "string" && QUOTA_BODY_KEYWORDS.some((re) => re.test(err))) {
          return `200-with-error: ${truncateForReason(err)}`;
        }
      }
    } catch {}
  }
  return null;
}

function detectAndMarkQuotaExhausted(status: number, body: string, runId?: string): void {
  const reason = detectQuotaExhausted(status, body);
  if (reason) {
    const kind = classifyQuotaKind(body);
    tokenTracker.markQuotaExhausted(status, reason, kind, runId);
  }
}

function truncateForReason(s: string, max = 160): string {
  const cleaned = s.trim().replace(/\s+/g, " ");
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export const tokenTracker = new TokenTracker();

/** Rough token estimate when a provider omits usage (≈4 chars/token). */
export function estimateTokensFromText(text: string | undefined | null): number {
  if (!text) return 0;
  const n = Math.ceil(text.length / 4);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Record one completed LLM call. Prefer real usage when present; otherwise
 * estimate from prompt + response text so the topbar is never stuck empty
 * after real agent work.
 */
export function recordChatUsage(input: {
  promptTokens?: number;
  responseTokens?: number;
  promptText?: string;
  responseText?: string;
  durationMs: number;
  model?: string;
  path?: string;
  runId?: string;
}): { promptTokens: number; responseTokens: number } {
  const promptTokens =
    input.promptTokens && input.promptTokens > 0
      ? input.promptTokens
      : estimateTokensFromText(input.promptText);
  const responseTokens =
    input.responseTokens && input.responseTokens > 0
      ? input.responseTokens
      : estimateTokensFromText(input.responseText);
  tokenTracker.add(
    {
      ts: Date.now(),
      promptTokens,
      responseTokens,
      durationMs: input.durationMs,
      model: input.model,
      path: input.path,
    },
    input.runId,
  );
  return { promptTokens, responseTokens };
}

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

    // Extract runId for clean per-run isolation (set by providers/gateway).
    const incomingRunId = (req.headers["x-swarm-run-id"] as string | undefined) || undefined;

    const proxyReq = httpRequest(
      {
        hostname: upstreamHost,
        port: upstreamPort,
        path: reqPath,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        const status = proxyRes.statusCode ?? 200;
        res.writeHead(status, proxyRes.headers);

        // Hardened streaming: forward immediately for backpressure.
        // Accumulate *only* a bounded last-payload window for usage extraction
        // (no full response buffering for long generations).
        const MAX_USAGE_BUF = 256 * 1024; // 256KB cap for usage parsing window
        let usageBuf = Buffer.alloc(0);
        let usageBufOver = false;

        proxyRes.on("data", (chunk: Buffer) => {
          res.write(chunk); // forward immediately

          // Incremental accumulation (bounded)
          if (!usageBufOver) {
            if (usageBuf.length + chunk.length > MAX_USAGE_BUF) {
              // Keep the tail (likely contains final usage chunk for streams)
              const keep = Math.min(64 * 1024, MAX_USAGE_BUF);
              usageBuf = Buffer.concat([usageBuf.slice(-keep), chunk]).slice(-MAX_USAGE_BUF);
              usageBufOver = true;
            } else {
              usageBuf = Buffer.concat([usageBuf, chunk]);
            }
          }
        });

        proxyRes.on("end", () => {
          res.end();

          // Best-effort, bounded parsing. Never blocks or throws to caller.
          try {
            const bodyForParse = usageBuf.toString("utf8");
            detectAndMarkQuotaExhausted(status, bodyForParse, incomingRunId);
            recordTokensFromBody(bodyForParse, {
              ts: Date.now(),
              durationMs: Date.now() - t0,
              path: reqPath,
            }, incomingRunId);
          } catch (err) {
            if (process.env.NODE_ENV !== "production") {
              console.warn("[proxy] token/usage recording failed (best effort):", err instanceof Error ? err.message : String(err));
            }
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

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`ollama-proxy: port ${opts.listenPort} is in use — set OLLAMA_PROXY_PORT=0 to disable or free the port`);
    } else {
      console.error(`ollama-proxy: ${err.message}`);
    }
  });
  server.listen(opts.listenPort, "127.0.0.1");

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        try {
          // Drop keep-alive sockets so close() completes; otherwise stop()
          // can hang while the main server already released :8243.
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        } catch {
          /* ignore */
        }
        server.close(() => resolve());
        // Bound wait — never block process exit on a stuck proxy socket.
        setTimeout(resolve, 500).unref?.();
      }),
  };
}

interface RecordCtx {
  ts: number;
  durationMs: number;
  path: string;
}

/**
 * Proxy-side token scrape DISABLED for ledger writes.
 * App-layer recordChatUsage (promptWithRetry / chatOnce) is the single
 * writer — recording here double-counted every local Ollama call that
 * already went through the SDK path. Quota detection still uses status/body
 * elsewhere; this stays as a no-op hook so the proxy stream path is unchanged.
 */
function recordTokensFromBody(body: string, _ctx: RecordCtx, _runId?: string): void {
  void body;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Exported for tests — pure extract without writing the ledger. */
export function extractTokensFromProxyPayload(obj: unknown, ctx: RecordCtx): UsageRecord | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const usage = (o.usage && typeof o.usage === "object") ? (o.usage as Record<string, unknown>) : null;
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
