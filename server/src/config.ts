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
  // E3 Phase 5 cleanup pt 4 (2026-04-29): USE_SESSION_PROVIDER +
  // USE_SESSION_NO_OPENCODE env flags REMOVED. The provider path is
  // now the only path; the opencode subprocess fallback no longer
  // exists in code. No escape hatch — if you hit a regression you
  // file a bug, you don't toggle a flag.
  // Unit 17: send a tiny "reply with: ok" prompt to each agent right
  // after spawn so its first REAL prompt isn't a cold-start. Default
  // on; set to "false"/"0"/"no" to disable (e.g. for unit-test rigs
  // where the SDK is mocked).
  AGENT_WARMUP_ENABLED: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("true")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Unit 26: Playwright MCP integration. When enabled, every
  // synthesized opencode.json gains an `mcp.playwright` entry that
  // spawns @playwright/mcp as a local subprocess, plus a new
  // `swarm-ui` agent profile that can call browser_navigate /
  // browser_snapshot / browser_click / etc. Default OFF so users
  // who don't use UI inspection don't need @playwright/mcp on
  // their box; opting in requires `npm install -g @playwright/mcp
  // && npx playwright install` first.
  MCP_PLAYWRIGHT_ENABLED: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Unit 30: council-style initial contract for the blackboard preset.
  // When enabled, turn 0 runs a two-phase contract pass:
  //   (a) DRAFT — all N agents independently produce a first-pass
  //       contract from the same seed, in parallel (peer-hidden)
  //   (b) MERGE — the planner sees every draft and produces a single
  //       authoritative contract (union distinct outcomes, dedupe
  //       synonyms, prefer grounded paths)
  // Buys cognitive diversity on contract framing without changing the
  // rest of the run (todos + audit still flow through agent-1 as
  // planner, preserving session continuity). Default OFF so existing
  // runs are unaffected; turn it on to A/B whether N-draft contracts
  // catch anything agent-1-alone missed.
  COUNCIL_CONTRACT_ENABLED: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Unit 34: ambition ratchet. When enabled, a blackboard run that would
  // otherwise terminate on "all contract criteria satisfied" instead
  // promotes a TIER N+1 contract — the planner sees the prior tier's
  // state + verdicts and produces a more ambitious next-tier contract.
  // The run climbs tiers until a hard cap trips (wall-clock / commits /
  // todos), max tiers reached, or tier-up prompts fail repeatedly.
  // Task #126 (2026-04-25): default flipped from "false" to "true".
  // The ratchet is what makes blackboard climb to harder problems
  // after solving the initial contract — without it, blackboard runs
  // top out at the first contract and don't push toward more
  // ambitious goals. AMBITION_RATCHET_MAX_TIERS=5 keeps it bounded.
  // Per-run `ambitionTiers` knob on RunConfig still wins.
  AMBITION_RATCHET_ENABLED: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("true")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Unit 34: maximum number of tiers a single run can climb (belt-and-
  // suspenders guard against an infinite-climb bug). Per-run
  // `ambitionTiers` cap on RunConfig wins over this when set. 5 is a
  // pragmatic default — the wall-clock/commits caps are the real stop,
  // this is just a safety valve.
  AMBITION_RATCHET_MAX_TIERS: z
    .string()
    .default("5")
    .transform((v) => {
      const n = Number.parseInt(v, 10);
      return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 5;
    }),
  // Unit 35: critic agent at commit time. When enabled, a peer agent
  // reviews every worker diff before it lands — reject verdict marks
  // the todo stale so the replanner finds a different angle. Catches
  // the specific busywork patterns the auditor's string-match verdict
  // is too coarse to catch (duplicate-content test pyramids, rename-
  // only reorgs, stub implementations labelled "done"). Default OFF
  // because it adds one prompt per commit; flip on for long autonomous
  // runs where the cost is worth the quality floor.
  CRITIC_ENABLED: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // T-Item-MultiTenant Phase 4 (2026-05-04): max concurrent runs the
  // orchestrator will accept. Default 4; set to 1 to preserve the
  // pre-multi-tenant strict-single-run behavior. Capped at 16 as a
  // safety valve against accidentally-spawned-loop-of-runs.
  // Resource cost: each blackboard run pins ~4-5 Ollama agents; 4
  // concurrent runs ≈ 16-20 agents × per-model GPU/RAM. The user
  // is on the hook for sizing their host accordingly.
  SWARM_MAX_CONCURRENT_RUNS: z
    .string()
    .default("4")
    .transform((v) => {
      const n = Number.parseInt(v, 10);
      return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 4;
    }),
  // T-Item-Caps (2026-05-04): runtime cap overrides for the three
  // hard caps in blackboard/caps.ts. Defaults are the baked-in
  // values (8h wall, 200 commits, 300 todos). Set to override
  // without rebuilding. Per-run overrides via cfg.wallClockCapMs
  // still win over the env-derived default.
  // Wall-clock cap: minutes (env) → ms internally.
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
  // R6 wiring (2026-05-04): drain-by-default stop policy. When ON,
  // the first /api/swarm/stop click drains (finish current turn);
  // a second click within 5s hard-kills. Default OFF preserves the
  // legacy single-click hard-kill behavior.
  SWARM_DRAIN_ON_STOP: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // R5 wiring (2026-05-04): auto-resume on server startup. When ON,
  // the server scans known parent dirs at boot and auto-resumes
  // recoverable snapshots that meet the freshness/size policy.
  // Default OFF — auto-restoring runs the user wanted abandoned is
  // surprising; user opt-in only.
  SWARM_AUTO_RESUME: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // R13 wiring (2026-05-04): memory-pressure backpressure. When ON,
  // BlackboardRunner samples heap on each cap-tick and flips a
  // "memory-paused" flag when usage crosses 90% of heapTotal.
  // Default OFF — the cap watchdog already handles wall-clock; this
  // adds heap as an extra signal for very long runs.
  SWARM_MEMORY_BACKPRESSURE: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // R9 wiring (2026-05-04): semantic loop detector. When ON, the
  // runner evaluates Jaccard similarity over the last K agent turns
  // after each turn; on detected loop, injects a "you're going in
  // circles" amendment. Default OFF — false positives on tight
  // technical discussion (where vocabulary repeats by design) are
  // still a real risk; opt in once you've calibrated the threshold.
  SWARM_LOOP_DETECTION: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // R7 wiring (2026-05-04): pause-on-WS-disconnect. When ON, the
  // run pauses new dispatch when its last WS subscriber drops; on
  // first reconnect, resumes (unless quota / user-paused). Default
  // OFF — could break headless / cron callers that legitimately
  // never connect a browser.
  SWARM_PAUSE_ON_DISCONNECT: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // R1 wiring (2026-05-04): provider failover chain. Comma-separated
  // model strings (provider-prefixed, e.g.
  // "anthropic/claude-haiku-4-5,glm-5.1:cloud"). When the active
  // model hits a quota / auth wall, the runner swaps to the next
  // model in this list. Default empty (R1 disabled). Per-run
  // cfg.providerFailover overrides this when set.
  SWARM_PROVIDER_FAILOVER: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  // R3 wiring (2026-05-04): when the cloud failover chain is
  // exhausted, fall back to a local Ollama model. Default OFF.
  // Caller's job to ensure the local Ollama install has at least one
  // model pulled (we discover via /api/tags at run-start).
  SWARM_DEGRADATION_FALLBACK: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // R3 wiring (2026-05-04): preferred local model order when
  // degrading. Comma-separated. Empty → pickLocalFallback chooses by
  // size (largest first). When set, first match wins.
  SWARM_DEGRADATION_PREFERRED: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  // R10 wiring (2026-05-04): proactive model-health swap. When ON,
  // before each prompt the runner evaluates the active model's
  // recent success rate (sliding window of 10, threshold 50% over
  // ≥5 samples). Degraded models are swapped pre-flight so we don't
  // burn a turn re-confirming what the tracker already knows.
  // Default OFF — only fires after enough samples have accumulated
  // anyway; opt-in keeps the legacy "try-anyway" semantics by default.
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
