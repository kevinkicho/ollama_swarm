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
