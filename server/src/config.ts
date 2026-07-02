import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src/config.ts (dev) or server/dist/config.ts (built) → up two to repo root.
const repoRoot = path.resolve(here, "..", "..");
const portFile = path.join(repoRoot, ".server-port");
// Load .env from repo root explicitly. `dev.mjs` spawns the server with
// cwd=server/, so dotenv/config's default cwd-based lookup misses the
// canonical repo-root .env that .env.example documents.
dotenv.config({ path: path.join(repoRoot, ".env") });

function resolveServerPort(): number {
  // Explicit env wins over the auto-pick file so a user can still pin a port.
  const fromEnv = process.env.SERVER_PORT;
  if (fromEnv && fromEnv.trim() !== "") {
    const n = Number(fromEnv);
    if (Number.isInteger(n) && n > 0) return n;
  }
  try {
    const raw = fs.readFileSync(portFile, "utf8").trim();
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    // fall through
  }
  return 5174;
}

const Schema = z.object({
  OPENCODE_SERVER_USERNAME: z.string().min(1).default("opencode"),
  OPENCODE_SERVER_PASSWORD: z.string().optional().default("test-only"),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  OLLAMA_DIRECT_FALLBACK_URL: z.string().default("http://127.0.0.1:11533"),
  OLLAMA_TAGS_FALLBACK_URL: z.string().default("http://127.0.0.1:11434"),
  // Task #133: local Ollama proxy port. Server starts a thin HTTP
  // proxy on this port and rewrites the in-memory OLLAMA_BASE_URL to
  // point at it; the proxy forwards every request to the real Ollama
  // and snoops responses for prompt_eval_count + eval_count. Set to 0
  // to disable the proxy entirely (legacy direct-to-Ollama mode —
  // token tracking will be empty).
  OLLAMA_PROXY_PORT: z.coerce.number().int().min(0).max(65_535).default(11533),
  // Override log directory for concurrent server instances.
  // Default: <repoRoot>/logs — each server writes to its own directory.
  LOG_DIR: z.string().optional(),
  DEFAULT_MODEL: z.string().default("deepseek-v4-flash:cloud"),
  // Blackboard-only worker default. Workers do diff-generation and
  // benefit less from the planner's heavier reasoning model — gemma4
  // gives ~3-4× the tokens-per-second at acceptable code-edit quality.
  // Applied at the route layer when cfg.workerModel is absent AND
  // preset === 'blackboard'. Other presets fan agents through `model`.
  DEFAULT_WORKER_MODEL: z.string().default("deepseek-v4-flash:cloud"),
  // Blackboard-only: default `dedicatedAuditor` to ON. Empirically
  // delegating audit to a separate agent (planner = pure planning,
  // auditor = pure auditing) improves overall teamwork — context
  // doesn't cross-contaminate. Per-run cfg.dedicatedAuditor=false
  // explicitly disables. Applied at the route layer.
  DEFAULT_DEDICATED_AUDITOR: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("true")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Blackboard-only: default auditor model = NEMOTRON. Auditor fires
  // rarely (every K commits + tier-up + final), so its higher latency
  // is amortized — but it does cross-criterion synthesis where the
  // strongest reasoning matters most. Per the opencode-swarm pattern.
  // Per-run cfg.auditorModel still overrides. Applied at the route
  // layer when preset === 'blackboard' AND dedicatedAuditor is on.
  DEFAULT_AUDITOR_MODEL: z.string().default("deepseek-v4-flash:cloud"),
  OPENCODE_BIN: z.string().default("opencode"),
  GITHUB_TOKEN: z.string().optional(),
  // Phase 1 of #314 (multi-provider): API keys for the paid SDKs.
  // Both optional — when unset the corresponding provider is greyed
  // out in the setup-form dropdown. The opencode subprocess inherits
  // process.env, so the AI-SDK packages (@ai-sdk/anthropic, @ai-sdk/
  // openai) read these directly without needing apiKey wired through
  // opencode.json. Keep keys server-side only — never echoed back to
  // the browser, never persisted to localStorage.
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // 2026-05-03: Ollama Cloud API key per https://docs.ollama.com/cloud.
  // Created at ollama.com/settings/keys. Optional — when unset, the
  // local Ollama install can still proxy `:cloud` models to ollama.com
  // automatically (Ollama handles the auth itself when an account is
  // configured locally), so the form always shows the ollama-cloud
  // catalog. The key is informational here for the providers endpoint
  // so the UI can show "live discovery vs catalog fallback" hints.
  OLLAMA_API_KEY: z.string().optional(),
  // 2026-05-04: dedicated key for Ollama Cloud direct API access.
  // When set, the OllamaCloudProvider sends requests directly to
  // https://ollama.com with Bearer auth, bypassing the local Ollama
  // daemon entirely. Falls back to OLLAMA_API_KEY if this is unset.
  OLLAMA_CLOUD_API_KEY: z.string().optional(),
  // OpenCode Go: subscription-based access to curated open models.
  // Falls back to Zen balance when Go limits are reached (if enabled in console).
  OPENCODE_GO_API_KEY: z.string().optional(),
  // OpenCode Zen: pay-as-you-go access to curated models (GPT, Claude, open).
  OPENCODE_ZEN_API_KEY: z.string().optional(),
  // OpenCode unified API key (works for both Go and Zen).
  OPENCODE_API_KEY: z.string().optional(),
  // OpenCode Zen: pay-as-you-go access to curated models (GPT, Claude, open).
  // Falls back to OPENCODE_GO_API_KEY if this is unset (same key works for both).
  // Historical: OPENCODE_* keys are still validated at load time for
  // backward compat with old test/dev setups (see run-tests.mjs shim).
  // The actual opencode subprocess path was removed in E3 (2026-04-29).
  // AGENT_WARMUP_ENABLED: send a tiny warmup prompt after spawn (default on).
  AGENT_WARMUP_ENABLED: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("true")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // MCP_PLAYWRIGHT_ENABLED: opt-in for Playwright MCP in generated
  // configs (historical integration point). Default off.
  MCP_PLAYWRIGHT_ENABLED: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Council-style initial contract for blackboard (optional diversity on first contract).
  COUNCIL_CONTRACT_ENABLED: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Ambition ratchet: allow blackboard to promote to harder contracts after satisfying the current one.
  AMBITION_RATCHET_ENABLED: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("true")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Max tiers for ambition ratchet (safety cap). Per-run overrides win.
  AMBITION_RATCHET_MAX_TIERS: z
    .string()
    .default("5")
    .transform((v) => {
      const n = Number.parseInt(v, 10);
      return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 5;
    }),
  // Critic at commit: peer review of worker diffs before commit (rejects mark stale).
  CRITIC_ENABLED: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Max concurrent runs (default 4, hard cap 16 for safety).
  SWARM_MAX_CONCURRENT_RUNS: z
    .string()
    .default("4")
    .transform((v) => {
      const n = Number.parseInt(v, 10);
      return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 4;
    }),
  // Runtime cap overrides (wall-clock in minutes, commits, todos). Per-run cfg wins.
  SWARM_WALL_CLOCK_CAP_MIN: z
    .string()
    .default("480")
    .transform((v) => {
      const n = Number.parseInt(v, 10);
      // Bound: [1 minute, 7 days] — a 1-week run is the absolute
      // upper-bound; longer should use cron / scheduled re-runs.
      return Number.isInteger(n) && n >= 1 && n <= 7 * 24 * 60 ? n : 480;
    }),
  SWARM_COMMITS_CAP: z
    .string()
    .default("200")
    .transform((v) => {
      const n = Number.parseInt(v, 10);
      // Bound: [1, 10000]. The runaway-prevention floor is 1; the
      // ceiling is just "obvious accident detection" — runs landing
      // 10K commits are testing infrastructure, not blackboard runs.
      return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 200;
    }),
  SWARM_TODOS_CAP: z
    .string()
    .default("300")
    .transform((v) => {
      const n = Number.parseInt(v, 10);
      return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 300;
    }),
  // Drain on first stop (finish turn); second within 5s kills. Default: immediate kill.
  SWARM_DRAIN_ON_STOP: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Auto-resume recoverable runs on startup (opt-in).
  SWARM_AUTO_RESUME: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Memory pressure backpressure (pause at 90% heap).
  SWARM_MEMORY_BACKPRESSURE: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Semantic loop detection (Jaccard on recent turns).
  SWARM_LOOP_DETECTION: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Pause runs when last WS subscriber disconnects.
  SWARM_PAUSE_ON_DISCONNECT: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Provider failover chain (comma-separated models).
  SWARM_PROVIDER_FAILOVER: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  // Fall back to local Ollama when cloud chain exhausted.
  SWARM_DEGRADATION_FALLBACK: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Preferred local models for degradation fallback (comma sep).
  SWARM_DEGRADATION_PREFERRED: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  // Proactive swap to healthier model when degraded.
  SWARM_MODEL_HEALTH_SWAP: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // AI brain fallback parser model. When a rule-based parser fails,
  // this lightweight model is asked to extract structured JSON from
  // the raw output. Default: gemma4:31b-cloud (fast, good at JSON).
  // Set to "" to disable brain fallback entirely.
  SWARM_BRAIN_MODEL: z
    .string()
    .default("deepseek-v4-flash:cloud")
    .transform((v) => v.trim()),
  // Production: directory containing built web assets. When set, the
  // server serves these as static files at / and falls through to API
  // routes. Defaults to the repo-root web/dist directory. Set to ""
  // or "none" to disable static serving (dev mode uses vite dev server).
  STATIC_DIR: z.string().default(""),
  // V2 substrate flags. USE_OLLAMA_DIRECT routes blackboard prompts
  // directly to Ollama; USE_WORKER_PIPELINE_V2 enables the V2 worker
  // path. Both default off — opt-in per-run.
  USE_OLLAMA_DIRECT: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  USE_WORKER_PIPELINE_V2: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Disable tool auto-dispatch for non-blackboard runners.
  SWARM_DISABLE_TOOLS_AUTO: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Conformance monitor: LLM-as-judge polls every 90s. Default on.
  CONFORMANCE_MONITOR: z
    .enum(["true", "false", "1", "0", "yes", "no", "off"])
    .default("true")
    .transform((v) => v !== "false" && v !== "0" && v !== "no" && v !== "off"),
  // PR-7: route LLM calls through ProviderGateway (rate limits + circuits).
  PROVIDER_GATEWAY: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // PR-9: weighted-fair scheduling across concurrent runs (requires gateway).
  SWARM_FAIR_SCHEDULING: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("true")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  PROVIDER_RATE_LIMIT_OLLAMA: z.coerce.number().positive().default(10),
  PROVIDER_RATE_LIMIT_ANTHROPIC: z.coerce.number().positive().default(5),
  PROVIDER_RATE_LIMIT_OPENAI: z.coerce.number().positive().default(5),
  PROVIDER_RATE_LIMIT_OPENCODE: z.coerce.number().positive().default(5),
  PROVIDER_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(3),
  PROVIDER_CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(1000).default(60_000),
});

const parsed = Schema.parse(process.env);

export const config = {
  ...parsed,
  SERVER_PORT: resolveServerPort(),
};

export function basicAuthHeader(): string {
  const raw = `${config.OPENCODE_SERVER_USERNAME}:${config.OPENCODE_SERVER_PASSWORD}`;
  return "Basic " + Buffer.from(raw, "utf8").toString("base64");
}
