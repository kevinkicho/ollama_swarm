// R12 (2026-05-04): pre-flight disk-space check.
//
// Cloning a repo + storing run-state + agent logs typically consumes
// 100MB-2GB on disk depending on repo size. If the user's disk is
// nearly full at run-start, we'd rather refuse than fail mid-clone
// with cryptic ENOSPC.
//
// Default threshold: 2 GB free. Caller can override via cfg.
//
// Two layers:
//   - getFreeDiskBytes(path): real fs.statfs call (Node ≥18.15)
//   - evaluateDiskHeadroom(freeBytes, requiredBytes): pure decision

import { statfs } from "node:fs/promises";

export const DEFAULT_REQUIRED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export interface DiskHeadroomVerdict {
  ok: boolean;
  freeBytes: number;
  requiredBytes: number;
  reason: string;
}

export function evaluateDiskHeadroom(input: {
  freeBytes: number;
  requiredBytes?: number;
}): DiskHeadroomVerdict {
  const { freeBytes, requiredBytes = DEFAULT_REQUIRED_BYTES } = input;
  const ok = Number.isFinite(freeBytes) && freeBytes >= requiredBytes;
  return {
    ok,
    freeBytes,
    requiredBytes,
    reason: ok
      ? `${formatBytes(freeBytes)} free ≥ ${formatBytes(requiredBytes)} required`
      : `only ${formatBytes(freeBytes)} free, need ${formatBytes(requiredBytes)}`,
  };
}

/** Best-effort free-bytes query at the given path. Returns null on
 *  any error (filesystem doesn't support statfs, path missing, etc.)
 *  so the caller can fall through gracefully. */
export async function getFreeDiskBytes(targetPath: string): Promise<number | null> {
  try {
    const s = await statfs(targetPath);
    // statfs returns block sizes in bsize/bfree; product is free bytes.
    return s.bsize * s.bfree;
  } catch {
    return null;
  }
}

/** End-to-end async check. Returns a verdict; returns ok=true with
 *  reason "disk-space check unavailable" when we couldn't read the
 *  fs (don't block the run on a missing capability). */
export async function preflightDiskCheck(input: {
  targetPath: string;
  requiredBytes?: number;
}): Promise<DiskHeadroomVerdict> {
  const free = await getFreeDiskBytes(input.targetPath);
  if (free == null) {
    return {
      ok: true,
      freeBytes: 0,
      requiredBytes: input.requiredBytes ?? DEFAULT_REQUIRED_BYTES,
      reason: "disk-space check unavailable — proceeding without verification",
    };
  }
  return evaluateDiskHeadroom({ freeBytes: free, requiredBytes: input.requiredBytes });
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n}B`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
