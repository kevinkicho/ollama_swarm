/**
 * Ollama-native API helpers (github.com/ollama/ollama/blob/main/docs/api.md).
 *
 * **Hard rule:** every function here is for provider `ollama` / `ollama-cloud`
 * only. Callers MUST gate with `isOllamaFamilyModel()` before invoking.
 * OpenCode / Anthropic / OpenAI never import or hit these endpoints.
 */

import { detectProvider } from "@ollama-swarm/shared/providers";
import { toOllamaCloudApiModelName } from "./discoverOllamaCloudModels.js";

/** True when model string routes to local Ollama or Ollama Cloud — not OpenCode. */
export function isOllamaFamilyModel(model: string): boolean {
  const p = detectProvider(model);
  return p === "ollama" || p === "ollama-cloud";
}

export type OllamaThink = boolean | "low" | "medium" | "high" | "max";

export interface OllamaShowDetails {
  parent_model?: string;
  format?: string;
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
}

export interface OllamaShowResult {
  model: string;
  /** API name used in the show request (cloud-stripped when needed). */
  apiModel: string;
  capabilities: string[];
  details?: OllamaShowDetails;
  /** Context length when present in model_info. */
  contextLength?: number;
  /** Raw model_info keys of interest (optional). */
  modelInfo?: Record<string, unknown>;
  raw?: unknown;
}

export interface OllamaPsModel {
  name: string;
  model?: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
  details?: OllamaShowDetails;
}

/**
 * Cloud retirement table from docs.ollama.com/cloud (upcoming/past).
 * Keys are bare API names (no :cloud). Values are recommended alternatives.
 */
export const OLLAMA_CLOUD_RETIREMENTS: Readonly<Record<string, string | null>> = {
  "deepseek-v3.1:671b": "deepseek-v4-flash",
  "deepseek-v3.2": "deepseek-v4-flash",
  "devstral-2:123b": "mistral-large-3:675b",
  "devstral-small-2:24b": null,
  "ministral-3:14b": null,
  "ministral-3:3b": null,
  "ministral-3:8b": null,
  "gemini-3-flash-preview": "minimax-m3",
  "gemma3:12b": "gemma4:31b",
  "gemma3:27b": "gemma4:31b",
  "gemma3:4b": "gemma4:31b",
  "glm-4.7": "glm-5.2",
  "glm-5": "glm-5.2",
  "minimax-m2.1": "minimax-m3",
  "qwen3-coder-next": "qwen3.5:397b",
  "qwen3-coder:480b": "qwen3.5:397b",
  "rnj-1:8b": null,
  "kimi-k2-thinking": "kimi-k2.6",
  "kimi-k2:1t": "kimi-k2.6",
  "minimax-m2": "minimax-m3",
  "glm-4.6": "glm-5.1",
  "qwen3-next:80b": "qwen3.5",
  "qwen3-vl:235b": "qwen3.5",
  "qwen3-vl:235b-instruct": "qwen3.5",
  "cogito-2.1:671b": "deepseek-v4-flash",
};

export function lookupCloudRetirement(model: string): {
  retired: boolean;
  apiName: string;
  alternative: string | null | undefined;
} {
  const apiName = toOllamaCloudApiModelName(model);
  const alt = OLLAMA_CLOUD_RETIREMENTS[apiName];
  if (alt !== undefined) {
    return { retired: true, apiName, alternative: alt };
  }
  // Also match bare family without size when table uses bare keys.
  const bare = apiName.split(":")[0] ?? apiName;
  for (const [k, v] of Object.entries(OLLAMA_CLOUD_RETIREMENTS)) {
    if (k === bare || k.startsWith(bare + ":")) {
      return { retired: true, apiName, alternative: v };
    }
  }
  return { retired: false, apiName, alternative: undefined };
}

export interface RoleOllamaOptions {
  temperature?: number;
  top_p?: number;
  num_ctx?: number;
  num_predict?: number;
  seed?: number;
  [key: string]: unknown;
}

/**
 * Role-biased Ollama `options` — only applied for ollama family models.
 * Conservative defaults; topology temperature still wins when set.
 */
export function ollamaOptionsForRole(
  role: string | undefined,
  base?: RoleOllamaOptions,
): RoleOllamaOptions {
  const roleKey = (role ?? "worker").toLowerCase();
  const extras: RoleOllamaOptions = { ...base };
  // Planner / auditor / lead: more context headroom for repo tours.
  if (
    roleKey === "planner" ||
    roleKey === "auditor" ||
    roleKey === "orchestrator" ||
    roleKey === "reducer" ||
    roleKey === "judge"
  ) {
    if (extras.num_ctx == null) extras.num_ctx = 32_768;
  }
  // Workers emitting JSON hunks: cap completion length to reduce runaway streams.
  if (
    roleKey === "worker" ||
    roleKey === "mapper" ||
    roleKey === "drafter" ||
    roleKey === "explorer"
  ) {
    if (extras.num_predict == null) extras.num_predict = 8_192;
  }
  return extras;
}

/** Default keep_alive while a swarm run is active (Ollama only). */
export const OLLAMA_RUN_KEEP_ALIVE = "30m";

/**
 * Think mode for emit-only / JSON worker turns — prefer less thinking cost
 * when the call is format-constrained. OpenCode never sees this field.
 */
export function ollamaThinkForCall(input: {
  hasJsonFormat?: boolean;
  tools?: boolean;
  explicit?: OllamaThink;
}): OllamaThink | undefined {
  if (input.explicit !== undefined) return input.explicit;
  // JSON emit-only: ask for low/off thinking when supported.
  if (input.hasJsonFormat && !input.tools) return false;
  return undefined; // inherit model default
}

export interface OllamaShowOpts {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function ollamaShow(opts: OllamaShowOpts): Promise<OllamaShowResult | null> {
  if (!isOllamaFamilyModel(opts.model) && !opts.model.includes(":")) {
    // Allow bare names when caller already stripped provider for cloud host.
  }
  const baseUrl = opts.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  // On cloud host, show must use API name (no :cloud suffix).
  const isCloudHost = /ollama\.com$/i.test(new URL(baseUrl.includes("://") ? baseUrl : `http://${baseUrl}`).hostname);
  const apiModel = isCloudHost || detectProvider(opts.model) === "ollama-cloud"
    ? toOllamaCloudApiModelName(opts.model)
    : opts.model;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const r = await (opts.fetchImpl ?? fetch)(`${baseUrl}/api/show`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: apiModel }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as {
      capabilities?: string[];
      details?: OllamaShowDetails;
      model_info?: Record<string, unknown>;
    };
    const info = body.model_info ?? {};
    let contextLength: number | undefined;
    for (const [k, v] of Object.entries(info)) {
      if (k.endsWith(".context_length") && typeof v === "number") {
        contextLength = v;
        break;
      }
    }
    return {
      model: opts.model,
      apiModel,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
      details: body.details,
      contextLength,
      modelInfo: info,
      raw: body,
    };
  } catch {
    return null;
  }
}

export async function ollamaListRunning(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OllamaPsModel[] | null> {
  const baseUrl = opts.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  try {
    const headers: Record<string, string> = {};
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const r = await (opts.fetchImpl ?? fetch)(`${baseUrl}/api/ps`, {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { models?: OllamaPsModel[] };
    return body.models ?? [];
  } catch {
    return null;
  }
}

/**
 * Unload a model from memory (empty chat + keep_alive: 0).
 * Local Ollama only — skip for OpenCode models (caller must gate).
 */
export async function ollamaUnloadModel(opts: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  if (!isOllamaFamilyModel(opts.model)) return false;
  const baseUrl = opts.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const isCloudHost = /ollama\.com$/i.test(
    new URL(baseUrl.includes("://") ? baseUrl : `http://${baseUrl}`).hostname,
  );
  const apiModel = isCloudHost || detectProvider(opts.model) === "ollama-cloud"
    ? toOllamaCloudApiModelName(opts.model)
    : opts.model;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const r = await (opts.fetchImpl ?? fetch)(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: apiModel,
        messages: [],
        keep_alive: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
