// Direction 5 Phase 1: persistent agent memory across runs.
//
// MemoryStore is a per-project key-value store that persists between
// runs. It lives at <clone>/swarm-memory.json and is loaded at run
// start, written at run end. Entries are keyed by namespaced paths
// (e.g., "project/conventions/prefer-immutability") and carry
// metadata (source, confidence, tags, access count).
//
// Phase 2 (auto-extraction) reads the run transcript after completion
// and calls an LLM to extract conventions, mistakes, and preferences
// as memory entries. Phase 3 injects relevant memories into agent
// prompts. Phase 4 adds a CRUD API + UI.
//
// Format: single JSON file, loaded into memory, debounced write.

import { promises as fs } from "node:fs";
import path from "node:path";

const MEMORY_FILE = "swarm-memory.json";

export interface MemoryEntry {
  key: string;
  value: string;
  source: "agent" | "user" | "auto";
  confidence: number;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  tags: string[];
}

export interface MemoryQuery {
  query: string;
  topK?: number;
  tags?: string[];
  minConfidence?: number;
}

export class MemoryStore {
  private entries: Map<string, MemoryEntry> = new Map();
  private dirty = false;
  private writeTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly filePath: string;
  private readonly debounceMs: number;

  constructor(clonePath: string, debounceMs = 1000) {
    this.filePath = path.join(clonePath, MEMORY_FILE);
    this.debounceMs = debounceMs;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) {
          if (entry && typeof entry.key === "string") {
            this.entries.set(entry.key, entry);
          }
        }
      }
    } catch {
      // malformed file — start fresh
    }
  }

  store(key: string, value: string, tags?: string[], source: MemoryEntry["source"] = "auto"): void {
    const existing = this.entries.get(key);
    const now = Date.now();
    if (existing) {
      existing.value = value;
      existing.tags = tags ?? existing.tags;
      existing.source = source;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.lastAccessedAt = now;
    } else {
      this.entries.set(key, {
        key,
        value,
        source,
        confidence: 0.5,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        tags: tags ?? [],
      });
    }
    this.dirty = true;
    this.scheduleWrite();
  }

  query(query: MemoryQuery): MemoryEntry[] {
    const { topK = 10, tags, minConfidence = 0 } = query;
    const tokens = query.query.toLowerCase().split(/\s+/).filter((t: string) => t.length > 2);
    const results: Array<{ entry: MemoryEntry; score: number }> = [];

    for (const entry of this.entries.values()) {
      if (entry.confidence < minConfidence) continue;
      if (tags && tags.length > 0 && !tags.some((t) => entry.tags.includes(t))) continue;

      let score = 0;
      const keyLower = entry.key.toLowerCase();
      const valueLower = entry.value.toLowerCase();

      for (const token of tokens) {
        if (keyLower.includes(token)) score += 2;
        if (valueLower.includes(token)) score += 1;
        if (entry.tags.some((t) => t.toLowerCase().includes(token))) score += 3;
      }

      if (score > 0) {
        entry.accessCount++;
        entry.lastAccessedAt = Date.now();
        results.push({ entry, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    this.dirty = true;
    this.scheduleWrite();
    return results.slice(0, topK).map((r) => r.entry);
  }

  forget(key: string): boolean {
    const deleted = this.entries.delete(key);
    if (deleted) {
      this.dirty = true;
      this.scheduleWrite();
    }
    return deleted;
  }

  decay(halfLifeDays = 30): void {
    const now = Date.now();
    const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
    const toDelete: string[] = [];

    for (const [key, entry] of this.entries) {
      const ageMs = now - entry.createdAt;
      const decayFactor = Math.pow(0.5, ageMs / halfLifeMs);
      entry.confidence = Math.max(0.1, entry.confidence * decayFactor);

      if (entry.confidence < 0.1 || (ageMs > halfLifeMs * 2 && entry.accessCount < 2)) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.entries.delete(key);
    }

    if (toDelete.length > 0 || toDelete.length > 0) {
      this.dirty = true;
      this.scheduleWrite();
    }
  }

  snapshot(): MemoryEntry[] {
    return [...this.entries.values()];
  }

  get(key: string): MemoryEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      entry.accessCount++;
      entry.lastAccessedAt = Date.now();
      this.dirty = true;
      this.scheduleWrite();
    }
    return entry;
  }

  private scheduleWrite(): void {
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
    }
    this.writeTimeout = setTimeout(() => {
      this.flushSync();
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    this.flushSync();
  }

  private flushSync(): void {
    if (!this.dirty) return;
    const json = JSON.stringify({ entries: [...this.entries.values()] }, null, 2);
    fs.writeFile(this.filePath, json, "utf8")
      .then(() => { this.dirty = false; })
      .catch(() => { /* write failed — dirty stays true for next retry */ });
  }
}

export async function loadMemoryStore(clonePath: string): Promise<MemoryStore> {
  const store = new MemoryStore(clonePath);
  await store.load();
  store.decay();
  return store;
}

export function buildMemoryPrompt(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = ["## Project Memory", ""];
  for (const entry of entries) {
    const tagStr = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
    lines.push(`- **${entry.key}**${tagStr}: ${entry.value} (confidence: ${(entry.confidence * 100).toFixed(0)}%)`);
  }
  lines.push("");
  lines.push("(auto-extracted from past runs — verify before relying on specifics)");
  return lines.join("\n");
}