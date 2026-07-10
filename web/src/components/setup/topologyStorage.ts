/**
 * localStorage helpers for TopologyGrid last-used + saved topologies.
 */

import type { Topology } from "../../../../shared/src/topology";

const LAST_USED_PREFIX = "ollama-swarm:topology:last-used:";
const SAVED_KEY = "ollama-swarm:topology:saved";
const SAVED_MAX = 32;

export interface SavedTopology {
  name: string;
  preset: string;
  topology: Topology;
  ts: number;
}

export function readLastUsed(presetId: string): Topology | null {
  try {
    const raw = localStorage.getItem(`${LAST_USED_PREFIX}${presetId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.agents)) return parsed as Topology;
  } catch {
    // localStorage disabled / parse error — silent fallback to defaults.
  }
  return null;
}

export function writeLastUsed(presetId: string, t: Topology): void {
  try {
    localStorage.setItem(`${LAST_USED_PREFIX}${presetId}`, JSON.stringify(t));
  } catch {
    // quota / disabled — silent.
  }
}

export function readSavedList(): SavedTopology[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as SavedTopology[];
  } catch {
    // ignore
  }
  return [];
}

export function writeSavedList(list: SavedTopology[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, SAVED_MAX)));
  } catch {
    // ignore
  }
}

export { SAVED_MAX };
