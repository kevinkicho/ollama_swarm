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
  OPENCODE_BASE_URL: z.string().url().default("http://127.0.0.1:4096"),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  DEFAULT_MODEL: z.string().default("glm-5.1:cloud"),
  OPENCODE_BIN: z.string().default("opencode"),
  GITHUB_TOKEN: z.string().optional(),
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
  // Default OFF so existing runs are byte-identical.
  AMBITION_RATCHET_ENABLED: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
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
