// Patch cache for the brain system overseer.
//
// Caches generated patches so they don't need to be regenerated when
// the target file hasn't changed. Each patch stores the content hash
// of the target file at generation time.

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export interface GeneratedPatch {
  proposalId: string;
  file: string;
  hunks: Array<{ op: string; file: string; search?: string; replace?: string; content?: string }>;
  contentHash: string;
  verified: boolean;
  generatedAt: number;
}

export interface PatchCacheData {
  patches: Record<string, GeneratedPatch>;
  lastGeneratedAt: number;
}

const CACHE_FILE = ".swarm-improvements/patch-cache.json";

export async function readPatchCache(clonePath: string): Promise<PatchCacheData> {
  const cachePath = path.join(clonePath, CACHE_FILE);
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw) as PatchCacheData;
  } catch {
    return { patches: {}, lastGeneratedAt: 0 };
  }
}

export async function writePatchCache(clonePath: string, data: PatchCacheData): Promise<void> {
  const cachePath = path.join(clonePath, CACHE_FILE);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(data, null, 2));
}

/**
 * Compute a hash of file content for cache invalidation.
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Check if a cached patch is still valid (target file hasn't changed).
 */
export function isPatchValid(
  cache: PatchCacheData,
  proposalId: string,
  currentContentHash: string,
): boolean {
  const cached = cache.patches[proposalId];
  if (!cached) return false;
  return cached.contentHash === currentContentHash && cached.verified;
}
