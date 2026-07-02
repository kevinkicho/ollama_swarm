// Honest provider health: config (keys), cached live probes, gateway runtime.

import { detectProvider, type Provider } from "@ollama-swarm/shared/providers";
import { PROVIDERS } from "@ollama-swarm/shared/providers";
import { config } from "../config.js";
import { discoverAnthropicModels } from "./discoverAnthropicModels.js";
import { discoverOpenAIModels } from "./discoverOpenAIModels.js";
import { providerGateway, type ProviderHealthEntry } from "./ProviderGateway.js";

export type ProviderProbeStatus =
  | "unconfigured"
  | "idle"
  | "ok"
  | "degraded"
  | "rate_limited"
  | "down";

export type ProbeStage = "config" | "reachability" | "auth";

export interface ProviderRuntimeHealth {
  circuit: ProviderHealthEntry["circuit"];
  headroom: number;
  queueDepth: number;
  failures: number;
  gatewayEnabled: boolean;
}

export interface ProviderHealthRecord {
  provider: Provider;
  available: boolean;
  hasKey: boolean;
  envVars: string[];
  probeStatus: ProviderProbeStatus;
  probeStage: ProbeStage;
  lastProbeAt?: number;
  lastProbeMs?: number;
  lastError?: string;
  modelCount?: number;
  source: "live" | "cache" | "skipped";
  runtime: ProviderRuntimeHealth;
}

export interface ProvidersStatusPayload {
  providers: Record<Provider, ProviderHealthRecord>;
  gateway: {
    gatewayEnabled: boolean;
    fairScheduling: boolean;
    totalQueueDepth: number;
  };
  meta: {
    probedAt: number;
    nextProbeAt: number;
    schedulerRunning: boolean;
    staleAfterMs: number;
  };
}

const ALL_PROVIDERS = PROVIDERS as readonly Provider[];

const ENV_VARS: Record<Provider, string[]> = {
  ollama: [],
  "ollama-cloud": ["OLLAMA_CLOUD_API_KEY", "OLLAMA_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  opencode: ["OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"],
};

const PROBE_INTERVAL_MS = 10 * 60_000;
const PROBE_STALE_MS = 15 * 60_000;
const PROBE_DEGRADED_MS = 5_000;
const MANUAL_PROBE_COOLDOWN_MS = 30_000;

interface ProbeCacheEntry {
  record: Omit<ProviderHealthRecord, "runtime">;
}

const cache = new Map<Provider, ProbeCacheEntry>();
let lastFullProbeAt = 0;
let nextScheduledProbeAt = 0;
let schedulerTimer: NodeJS.Timeout | null = null;
const lastManualProbeAt = new Map<Provider, number>();

export function hasProviderKey(provider: Provider): boolean {
  switch (provider) {
    case "ollama":
      return true;
    case "ollama-cloud":
      return !!(config.OLLAMA_CLOUD_API_KEY || config.OLLAMA_API_KEY);
    case "anthropic":
      return !!config.ANTHROPIC_API_KEY;
    case "openai":
      return !!config.OPENAI_API_KEY;
    case "opencode":
      return !!(
        config.OPENCODE_GO_API_KEY ||
        config.OPENCODE_ZEN_API_KEY ||
        config.OPENCODE_API_KEY
      );
  }
}

function providerAvailable(provider: Provider): boolean {
  switch (provider) {
    case "ollama":
    case "ollama-cloud":
      return true;
    default:
      return hasProviderKey(provider);
  }
}

function classifyProbeResult(
  ok: boolean,
  statusCode: number | undefined,
  elapsedMs: number,
  hasKey: boolean,
): { probeStatus: ProviderProbeStatus; lastError?: string } {
  if (!hasKey && statusCode === undefined) {
    return { probeStatus: "unconfigured" };
  }
  if (statusCode === 429) {
    return { probeStatus: "rate_limited", lastError: "HTTP 429 rate limited" };
  }
  if (!ok) {
    return { probeStatus: "down", lastError: statusCode ? `HTTP ${statusCode}` : "probe failed" };
  }
  if (elapsedMs > PROBE_DEGRADED_MS) {
    return { probeStatus: "degraded", lastError: `slow response (${elapsedMs}ms)` };
  }
  return { probeStatus: "ok" };
}

function applyStalePolicy(
  entry: Omit<ProviderHealthRecord, "runtime">,
  now: number,
): Omit<ProviderHealthRecord, "runtime"> {
  if (entry.probeStatus === "unconfigured" || entry.probeStatus === "idle") return entry;
  if (!entry.lastProbeAt) return entry;
  const age = now - entry.lastProbeAt;
  if (age > PROBE_STALE_MS && entry.probeStatus === "ok") {
    return {
      ...entry,
      probeStatus: "degraded",
      lastError: entry.lastError ?? `probe stale (${Math.round(age / 60_000)}m ago)`,
      source: "cache",
    };
  }
  return entry;
}

async function probeOllama(fetchImpl: typeof fetch): Promise<{
  ok: boolean;
  statusCode?: number;
  elapsedMs: number;
  modelCount?: number;
  error?: string;
}> {
  const t0 = Date.now();
  const url = `${config.OLLAMA_TAGS_FALLBACK_URL.replace(/\/$/, "")}/api/tags`;
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(4000) });
    const elapsedMs = Date.now() - t0;
    if (!r.ok) return { ok: false, statusCode: r.status, elapsedMs, error: `HTTP ${r.status}` };
    const body = (await r.json()) as { models?: unknown[] };
    return { ok: true, elapsedMs, modelCount: body.models?.length ?? 0 };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeOllamaCloud(fetchImpl: typeof fetch): Promise<{
  ok: boolean;
  statusCode?: number;
  elapsedMs: number;
  modelCount?: number;
  error?: string;
  viaLocal?: boolean;
}> {
  const cloudKey = config.OLLAMA_CLOUD_API_KEY || config.OLLAMA_API_KEY;
  if (cloudKey) {
    const t0 = Date.now();
    try {
      const r = await fetchImpl("https://ollama.com/api/tags", {
        headers: { Authorization: `Bearer ${cloudKey}` },
        signal: AbortSignal.timeout(5000),
      });
      const elapsedMs = Date.now() - t0;
      if (r.status === 429) return { ok: false, statusCode: 429, elapsedMs };
      if (!r.ok) return { ok: false, statusCode: r.status, elapsedMs, error: `HTTP ${r.status}` };
      const body = (await r.json()) as { models?: unknown[] };
      return { ok: true, elapsedMs, modelCount: body.models?.length ?? 0 };
    } catch (err) {
      return {
        ok: false,
        elapsedMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const local = await probeOllama(fetchImpl);
  return { ...local, viaLocal: true };
}

async function probeOpenCode(fetchImpl: typeof fetch): Promise<{
  ok: boolean;
  statusCode?: number;
  elapsedMs: number;
  error?: string;
}> {
  const key =
    config.OPENCODE_ZEN_API_KEY ||
    config.OPENCODE_GO_API_KEY ||
    config.OPENCODE_API_KEY;
  if (!key) return { ok: false, elapsedMs: 0, error: "no API key" };
  const t0 = Date.now();
  try {
    const r = await fetchImpl("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "glm-5.1",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const elapsedMs = Date.now() - t0;
    if (r.status === 429) return { ok: false, statusCode: 429, elapsedMs };
    if (r.ok || r.status === 400) {
      // 400 often means reachable + authed but bad params — good enough for auth probe
      return { ok: true, elapsedMs, statusCode: r.status };
    }
    return { ok: false, statusCode: r.status, elapsedMs, error: `HTTP ${r.status}` };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeProvider(
  provider: Provider,
  fetchImpl: typeof fetch,
): Promise<Omit<ProviderHealthRecord, "runtime">> {
  const hasKey = hasProviderKey(provider);
  const available = providerAvailable(provider);
  const now = Date.now();
  const base = {
    provider,
    available,
    hasKey,
    envVars: ENV_VARS[provider],
    probeStage: "auth" as ProbeStage,
    source: "live" as const,
  };

  if (!hasKey && provider !== "ollama" && provider !== "ollama-cloud") {
    return {
      ...base,
      probeStatus: "unconfigured",
      probeStage: "config",
      source: "skipped",
    };
  }

  let ok = false;
  let statusCode: number | undefined;
  let elapsedMs = 0;
  let modelCount: number | undefined;
  let error: string | undefined;
  let probeStage: ProbeStage = "reachability";

  switch (provider) {
    case "ollama": {
      const res = await probeOllama(fetchImpl);
      ok = res.ok;
      statusCode = res.statusCode;
      elapsedMs = res.elapsedMs;
      modelCount = res.modelCount;
      error = res.error;
      probeStage = "reachability";
      break;
    }
    case "ollama-cloud": {
      const res = await probeOllamaCloud(fetchImpl);
      ok = res.ok;
      statusCode = res.statusCode;
      elapsedMs = res.elapsedMs;
      modelCount = res.modelCount;
      error = res.viaLocal ? `${res.error ?? ""} (via local Ollama)`.trim() : res.error;
      probeStage = res.viaLocal ? "reachability" : "auth";
      break;
    }
    case "anthropic": {
      probeStage = "auth";
      const t0 = Date.now();
      const models = await discoverAnthropicModels({
        apiKey: config.ANTHROPIC_API_KEY,
        fetchImpl,
        timeoutMs: 5000,
      });
      elapsedMs = Date.now() - t0;
      ok = models !== null && models.length > 0;
      modelCount = models?.length;
      if (!ok) error = models === null ? "models discovery failed" : "empty model list";
      break;
    }
    case "openai": {
      probeStage = "auth";
      const t0 = Date.now();
      const models = await discoverOpenAIModels({
        apiKey: config.OPENAI_API_KEY,
        fetchImpl,
        timeoutMs: 5000,
      });
      elapsedMs = Date.now() - t0;
      ok = models !== null && models.length > 0;
      modelCount = models?.length;
      if (!ok) error = models === null ? "models discovery failed" : "empty model list";
      break;
    }
    case "opencode": {
      const res = await probeOpenCode(fetchImpl);
      ok = res.ok;
      statusCode = res.statusCode;
      elapsedMs = res.elapsedMs;
      error = res.error;
      probeStage = "auth";
      break;
    }
  }

  const classified = classifyProbeResult(ok, statusCode, elapsedMs, hasKey);
  return applyStalePolicy(
    {
      ...base,
      ...classified,
      lastError: classified.lastError ?? error,
      probeStage,
      lastProbeAt: now,
      lastProbeMs: elapsedMs,
      modelCount,
      source: "live",
    },
    now,
  );
}

function buildRuntime(provider: Provider): ProviderRuntimeHealth {
  const gw = providerGateway.getHealth()[provider];
  return {
    circuit: gw?.circuit ?? "closed",
    headroom: gw?.headroom ?? 0,
    queueDepth: gw?.queueDepth ?? 0,
    failures: gw?.failures ?? 0,
    gatewayEnabled: config.PROVIDER_GATEWAY,
  };
}

function mergeRecord(provider: Provider, now: number): ProviderHealthRecord {
  const cached = cache.get(provider);
  const probePart = applyStalePolicy(
    cached?.record ?? {
      provider,
      available: providerAvailable(provider),
      hasKey: hasProviderKey(provider),
      envVars: ENV_VARS[provider],
      probeStatus: hasProviderKey(provider) || provider === "ollama" ? "idle" : "unconfigured",
      probeStage: "config",
      source: "cache",
    },
    now,
  );
  return { ...probePart, runtime: buildRuntime(provider) };
}

export function getProvidersStatusPayload(): ProvidersStatusPayload {
  const now = Date.now();
  const providers = {} as Record<Provider, ProviderHealthRecord>;
  for (const p of ALL_PROVIDERS) {
    providers[p] = mergeRecord(p, now);
  }
  return {
    providers,
    gateway: {
      gatewayEnabled: config.PROVIDER_GATEWAY,
      fairScheduling: config.SWARM_FAIR_SCHEDULING,
      totalQueueDepth: providerGateway.getQueueDepth(),
    },
    meta: {
      probedAt: lastFullProbeAt,
      nextProbeAt: nextScheduledProbeAt,
      schedulerRunning: schedulerTimer !== null,
      staleAfterMs: PROBE_STALE_MS,
    },
  };
}

/** Legacy flat shape for routes that expect top-level provider keys. */
export function getProvidersApiResponse(): Record<string, unknown> {
  const payload = getProvidersStatusPayload();
  const out: Record<string, unknown> = {
    gateway: {
      gatewayEnabled: payload.gateway.gatewayEnabled,
      fairScheduling: payload.gateway.fairScheduling,
      providers: providerGateway.getHealth(),
      totalQueueDepth: payload.gateway.totalQueueDepth,
    },
    meta: payload.meta,
  };
  for (const p of ALL_PROVIDERS) {
    const rec = payload.providers[p];
    out[p] = {
      available: rec.available,
      hasKey: rec.hasKey,
      health: {
        probeStatus: rec.probeStatus,
        probeStage: rec.probeStage,
        lastProbeAt: rec.lastProbeAt,
        lastProbeMs: rec.lastProbeMs,
        lastError: rec.lastError,
        modelCount: rec.modelCount,
        envVars: rec.envVars,
        source: rec.source,
      },
      runtime: rec.runtime,
    };
  }
  return out;
}

export async function probeProviders(opts?: {
  providers?: Provider[];
  force?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<ProvidersStatusPayload> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const targets = opts?.providers?.length ? opts.providers : [...ALL_PROVIDERS];
  const now = Date.now();
  const stagger = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < targets.length; i++) {
    const provider = targets[i]!;
    if (!opts?.force) {
      const lastManual = lastManualProbeAt.get(provider) ?? 0;
      if (now - lastManual < MANUAL_PROBE_COOLDOWN_MS) {
        continue;
      }
    }
    const record = await probeProvider(provider, fetchImpl);
    cache.set(provider, { record });
    lastManualProbeAt.set(provider, now);
    if (i < targets.length - 1) await stagger(200);
  }

  if (targets.length === ALL_PROVIDERS.length) {
    lastFullProbeAt = now;
    nextScheduledProbeAt = now + PROBE_INTERVAL_MS;
  }

  return getProvidersStatusPayload();
}

export function startProviderHealthScheduler(): void {
  if (schedulerTimer) return;
  const tick = () => {
    void probeProviders({ force: true }).catch((err) => {
      console.warn(
        "[provider-health] scheduled probe failed:",
        err instanceof Error ? err.message : err,
      );
    });
  };
  void probeProviders({ force: true }).catch(() => {});
  schedulerTimer = setInterval(tick, PROBE_INTERVAL_MS);
  schedulerTimer.unref?.();
  nextScheduledProbeAt = Date.now() + PROBE_INTERVAL_MS;
}

export function stopProviderHealthScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

export function uniqueProvidersForModels(models: string[]): Provider[] {
  const seen = new Set<Provider>();
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed) continue;
    seen.add(detectProvider(trimmed));
  }
  return [...seen];
}

export type ProviderHealthSummary = Pick<
  ProviderHealthRecord,
  "probeStatus" | "lastError" | "hasKey" | "lastProbeAt" | "lastProbeMs"
>;

/** Summaries for models used in preflight / setup warnings. */
export function healthSummariesForProviders(
  providers: Provider[],
): Partial<Record<Provider, ProviderHealthSummary>> {
  const payload = getProvidersStatusPayload();
  const out: Partial<Record<Provider, ProviderHealthSummary>> = {};
  for (const p of providers) {
    const rec = payload.providers[p];
    out[p] = {
      hasKey: rec.hasKey,
      probeStatus: rec.probeStatus,
      lastError: rec.lastError,
      lastProbeAt: rec.lastProbeAt,
      lastProbeMs: rec.lastProbeMs,
    };
  }
  return out;
}

export interface ProviderProbeWarning {
  provider: Provider;
  model: string;
  probeStatus: ProviderProbeStatus;
  message: string;
}

const PROBE_WARNING_STATUSES: ReadonlySet<ProviderProbeStatus> = new Set([
  "down",
  "degraded",
  "rate_limited",
]);

/** Actionable probe warnings for models whose provider is not healthy. */
export function probeWarningsForModels(models: string[]): ProviderProbeWarning[] {
  const summaries = healthSummariesForProviders(uniqueProvidersForModels(models));
  const seen = new Set<string>();
  const out: ProviderProbeWarning[] = [];
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const provider = detectProvider(trimmed);
    const health = summaries[provider];
    if (!health || !PROBE_WARNING_STATUSES.has(health.probeStatus)) continue;
    const detail = health.lastError ? `: ${health.lastError}` : "";
    out.push({
      provider,
      model: trimmed,
      probeStatus: health.probeStatus,
      message: `${provider} probe ${health.probeStatus}${detail}`,
    });
  }
  return out;
}

/** Test-only reset for module-level probe cache + scheduler. */
export function __resetProviderHealthForTests(): void {
  cache.clear();
  lastFullProbeAt = 0;
  nextScheduledProbeAt = 0;
  lastManualProbeAt.clear();
  stopProviderHealthScheduler();
}