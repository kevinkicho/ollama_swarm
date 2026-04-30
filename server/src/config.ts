import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src/config.ts (dev) or server/dist/config.ts (built) → up two to repo root.
const repoRoot = path.resolve(here, "..", "..");
const portFile = path.join(repoRoot, ".server-port");

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
  OPENCODE_SERVER_PASSWORD: z.string().min(1, "OPENCODE_SERVER_PASSWORD is required in .env"),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  // Task #133: local Ollama proxy port. Server starts a thin HTTP
  // proxy on this port and rewrites the in-memory OLLAMA_BASE_URL to
  // point at it; the proxy forwards every request to the real Ollama
  // and snoops responses for prompt_eval_count + eval_count. Set to 0
  // to disable the proxy entirely (legacy direct-to-Ollama mode —
  // token tracking will be empty).
  OLLAMA_PROXY_PORT: z.coerce.number().int().min(0).max(65_535).default(11533),
  DEFAULT_MODEL: z.string().default("glm-5.1:cloud"),
  // Blackboard-only worker default. Workers do diff-generation and
  // benefit less from the planner's heavier reasoning model — gemma4
  // gives ~3-4× the tokens-per-second at acceptable code-edit quality.
  // Applied at the route layer when cfg.workerModel is absent AND
  // preset === 'blackboard'. Other presets fan agents through `model`.
  DEFAULT_WORKER_MODEL: z.string().default("gemma4:31b-cloud"),
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
  DEFAULT_AUDITOR_MODEL: z.string().default("nemotron-3-super:cloud"),
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
  // E3 Phase 2 (per docs/E3-drop-opencode-plan.md): when "true"/"1"/"yes",
  // promptWithRetry routes prompts through the SessionProvider
  // abstraction (server/src/providers/) instead of through opencode
  // session.prompt OR streamPrompt OR the older USE_OLLAMA_DIRECT
  // branch. Default OFF — existing behavior unchanged. Flip on per-run
  // for the validation gate (5+ stable runs across all presets) before
  // Phase 3 (replace AgentManager.spawnAgent) starts.
  // E3 Phase 5: defaults flipped to TRUE 2026-04-29 after Phases 1-4
  // landed. Both flags now default ON; opencode subprocess + opencode
  // session API are unreachable on the default path. Set either to
  // false ONLY as an escape hatch if a regression turns up.
  USE_SESSION_PROVIDER: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("true")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // E3 Phase 5: every runner spawns without an opencode subprocess by
  // default. The opencode CLI is no longer required on PATH. Prompts
  // route directly to Ollama / Anthropic / OpenAI via SessionProvider;
  // tools (read/grep/glob/list/bash) dispatched by ToolDispatcher with
  // the same per-profile permissions opencode used to enforce.
  //
  // The legacy AgentManager.spawnAgent + RepoService.writeOpencodeConfig
  // + @opencode-ai/sdk import remain in tree as a fallback (set
  // USE_SESSION_NO_OPENCODE=false to force them on). The expectation is
  // they're deleted entirely in a follow-up cleanup once this default
  // has baked across enough runs.
  USE_SESSION_NO_OPENCODE: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("true")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
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
