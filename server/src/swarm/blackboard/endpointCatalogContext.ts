// Grounding for API/route todos: surface existing endpoint catalog + .env key names
// so workers/planners avoid proposing duplicate proxy routes.

import { promises as fs } from "node:fs";
import path from "node:path";

const CATALOG_CANDIDATES = [
  "API_ENDPOINTS.md",
  "docs/API_ENDPOINTS.md",
  "GOVERNMENT_API_CATALOG.md",
  "docs/GOVERNMENT_API_CATALOG.md",
] as const;

const ENV_CANDIDATES = [".env", ".env.example", "functions/.env.example"] as const;

const API_TODO_RE =
  /\b(api|endpoint|route|proxy|panel|\.env|catalog|data source|webhook|fetch|http)\b/i;

export interface EndpointCatalogSnapshot {
  catalogPath?: string;
  catalogExcerpt?: string;
  envPath?: string;
  envKeys: string[];
}

export function todoTouchesApiSurface(description: string, expectedFiles: readonly string[]): boolean {
  if (API_TODO_RE.test(description)) return true;
  return expectedFiles.some(
    (f) =>
      /API_ENDPOINTS|GOVERNMENT_API|\.env|routes?\//i.test(f)
      || /\/routes\/[^/]+\.js$/i.test(f),
  );
}

function parseEnvKeys(raw: string): string[] {
  const keys = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m) keys.add(m[1]);
  }
  return [...keys].sort();
}

async function readFirstExisting(
  clonePath: string,
  candidates: readonly string[],
): Promise<{ rel: string; content: string } | null> {
  for (const rel of candidates) {
    const abs = path.join(clonePath, rel);
    try {
      const content = await fs.readFile(abs, "utf8");
      return { rel, content };
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function loadEndpointCatalogSnapshot(
  clonePath: string,
): Promise<EndpointCatalogSnapshot | null> {
  const catalog = await readFirstExisting(clonePath, CATALOG_CANDIDATES);
  const env = await readFirstExisting(clonePath, ENV_CANDIDATES);
  if (!catalog && !env) return null;

  const envKeys = env ? parseEnvKeys(env.content) : [];
  return {
    ...(catalog
      ? {
          catalogPath: catalog.rel,
          catalogExcerpt: catalog.content.slice(0, 6000),
        }
      : {}),
    ...(env ? { envPath: env.rel } : {}),
    envKeys,
  };
}

export function renderEndpointCatalogBlock(snap: EndpointCatalogSnapshot): string {
  const parts: string[] = [
    "=== EXISTING API / ENDPOINT GROUNDING (do NOT add duplicates) ===",
    "Before proposing new API proxy routes or endpoint table rows:",
    "1. Check whether the provider/route already exists in the catalog excerpt below.",
    "2. Check whether a matching env var key already exists (grep .env if unsure).",
    "3. Reuse existing routes/keys; only add genuinely new providers.",
  ];
  if (snap.catalogPath && snap.catalogExcerpt) {
    parts.push(
      "",
      `--- ${snap.catalogPath} (excerpt) ---`,
      snap.catalogExcerpt,
      `--- end ${snap.catalogPath} ---`,
    );
  }
  if (snap.envKeys.length > 0) {
    parts.push(
      "",
      `--- ${snap.envPath ?? ".env"} API-related keys (names only, no values) ---`,
      snap.envKeys
        .filter((k) => /API|KEY|TOKEN|URL|ENDPOINT|SECRET|AUTH/i.test(k))
        .join(", ") || "(no API-like keys found — list all keys for reference)",
      snap.envKeys.length > 0 && !snap.envKeys.some((k) => /API|KEY|TOKEN|URL/i.test(k))
        ? `All keys: ${snap.envKeys.join(", ")}`
        : "",
      `--- end env keys ---`,
    );
  } else if (snap.envPath) {
    parts.push("", `(${snap.envPath} present but no KEY= lines parsed)`);
  }
  parts.push("=== end API GROUNDING ===");
  return parts.filter((l) => l !== "").join("\n");
}