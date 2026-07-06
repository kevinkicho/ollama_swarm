// Swarm settings history — localStorage persistence for reusing configurations.
import { useState, useEffect, useCallback } from "react";

export interface SwarmSettings {
  id: string;
  label: string;
  repoUrl: string;
  parentPath: string;
  preset: string;
  model: string;
  provider: string;
  agentCount: number;
  rounds: number;
  userDirective: string;
  plannerModel: string;
  workerModel: string;
  auditorModel: string;
  // Auditor wiring (history persistence for #2)
  auditorOnlyMutations?: boolean;
  requireAuditorVerification?: boolean;
  webTools?: boolean;
  mcpServers?: string;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
}

const STORAGE_KEY = "ollama-swarm:settings-history";
const MAX_ENTRIES = 20;

function loadAll(): SwarmSettings[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveAll(entries: SwarmSettings[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

export function useSwarmSettings() {
  const [entries, setEntries] = useState<SwarmSettings[]>(() => loadAll());

  const save = useCallback((settings: Omit<SwarmSettings, "id" | "createdAt" | "lastUsedAt" | "useCount">) => {
    const now = Date.now();
    const all = loadAll();
    
    // If an entry with the same repoUrl + preset already exists, bump it
    // instead of creating a duplicate. This means useCount reflects actual
    // successful run count, not just form loads.
    const existingIdx = all.findIndex(
      (e) => e.repoUrl === settings.repoUrl && e.preset === settings.preset
    );
    
    let entry: SwarmSettings;
    if (existingIdx !== -1) {
      entry = { ...all[existingIdx], ...settings, lastUsedAt: now, useCount: all[existingIdx].useCount + 1 };
      all.splice(existingIdx, 1);
    } else {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      entry = { ...settings, id, createdAt: now, lastUsedAt: now, useCount: 1 };
    }
    
    const updated = [entry, ...all];
    saveAll(updated);
    setEntries(updated);
  }, []);

  const bumpUse = useCallback((id: string) => {
    const all = loadAll();
    const idx = all.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const entry = { ...all[idx], lastUsedAt: Date.now(), useCount: all[idx].useCount + 1 };
    const updated = [entry, ...all.slice(0, idx), ...all.slice(idx + 1)];
    saveAll(updated);
    setEntries(updated);
  }, []);

  const remove = useCallback((id: string) => {
    const updated = loadAll().filter((e) => e.id !== id);
    saveAll(updated);
    setEntries(updated);
  }, []);

  const removeAll = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setEntries([]);
  }, []);

  return { entries, save, bumpUse, remove, removeAll };
}
