// Contract/tier grounding: strip invented directory trees, optionally rebind
// plausible-new paths to similar in-repo siblings in the same parent directory.

import type { ParsedContract } from "./prompts/firstPassContract.js";
import {
  classifyPath,
  parentDir,
  type PathRejection,
  toForwardSlashes,
} from "./prompts/pathValidation.js";

export interface PathRebound {
  from: string;
  to: string;
}

export interface GroundExpectedFilesResult {
  grounded: string[];
  stripped: PathRejection[];
  rebound: PathRebound[];
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

function fileStem(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf(".");
  return (dot >= 0 ? base.slice(0, dot) : base).toLowerCase();
}

/** Find an existing repo file in the same directory with a similar basename. */
export function findSimilarRepoFile(path: string, repoFiles: readonly string[]): string | undefined {
  const norm = toForwardSlashes(path);
  const parent = parentDir(norm);
  if (!parent) return undefined;
  const prefix = `${parent}/`;
  const wantStem = fileStem(norm);
  if (wantStem.length < 2) return undefined;

  const siblings = repoFiles.filter((f) => f.startsWith(prefix));
  let best: { file: string; score: number } | undefined;

  for (const s of siblings) {
    if (s === norm) return s;
    const sStem = fileStem(s);
    let score = 0;
    if (sStem === wantStem) score = 100;
    else if (sStem.startsWith(wantStem) || wantStem.startsWith(sStem)) score = 80;
    else if (sStem.includes(wantStem) || wantStem.includes(sStem)) score = 60;
    else continue;
    if (!best || score > best.score) best = { file: s, score };
  }
  return best?.file;
}

export function groundExpectedFiles(
  paths: readonly string[],
  repoFiles: readonly string[],
  opts?: { reboundPlausibleNew?: boolean },
): GroundExpectedFilesResult {
  const reboundPlausibleNew = opts?.reboundPlausibleNew ?? true;
  const grounded: string[] = [];
  const stripped: PathRejection[] = [];
  const rebound: PathRebound[] = [];
  const seen = new Set<string>();

  for (const raw of paths) {
    const path = toForwardSlashes(raw);
    const verdict = classifyPath(path, repoFiles);
    if (verdict === "suspicious") {
      stripped.push({
        path,
        reason: `parent directory not in repo file list (${parentDir(path)})`,
      });
      continue;
    }
    if (verdict === "plausible-new" && reboundPlausibleNew) {
      const similar = findSimilarRepoFile(path, repoFiles);
      if (similar && similar !== path) {
        rebound.push({ from: path, to: similar });
        if (!seen.has(similar)) {
          seen.add(similar);
          grounded.push(similar);
        }
        continue;
      }
    }
    if (!seen.has(path)) {
      seen.add(path);
      grounded.push(path);
    }
  }

  return { grounded, stripped, rebound };
}

export interface ContractGroundingStats {
  totalInputPaths: number;
  totalStripped: number;
  totalRebound: number;
  strippedByParent: Map<string, number>;
}

export function assessContractGrounding(
  contract: ParsedContract,
  repoFiles: readonly string[],
): ContractGroundingStats {
  const strippedByParent = new Map<string, number>();
  let totalInputPaths = 0;
  let totalStripped = 0;
  let totalRebound = 0;

  for (const c of contract.criteria) {
    totalInputPaths += c.expectedFiles.length;
    const g = groundExpectedFiles(c.expectedFiles, repoFiles);
    totalStripped += g.stripped.length;
    totalRebound += g.rebound.length;
    for (const s of g.stripped) {
      const parent = parentDir(toForwardSlashes(s.path));
      if (parent) {
        strippedByParent.set(parent, (strippedByParent.get(parent) ?? 0) + 1);
      }
    }
  }

  return { totalInputPaths, totalStripped, totalRebound, strippedByParent };
}

/** Returns a parse-style error when the contract is too poorly grounded to accept. */
export function validateContractGrounding(
  contract: ParsedContract,
  repoFiles: readonly string[],
): string | null {
  const stats = assessContractGrounding(contract, repoFiles);
  if (stats.totalInputPaths === 0) return null;

  for (const [parent, count] of stats.strippedByParent) {
    if (count >= 3) {
      return (
        `grounding failed: ${count} expectedFiles under '${parent}/' are not in the REPO FILE LIST — ` +
        `use verbatim paths from the list, not invented directory layouts`
      );
    }
  }

  const ratio = stats.totalStripped / stats.totalInputPaths;
  if (stats.totalStripped >= 5 && ratio >= 0.35) {
    const pct = Math.round(ratio * 100);
    return (
      `grounding failed: ${stats.totalStripped}/${stats.totalInputPaths} expectedFiles (${pct}%) ` +
      `reference directories absent from the REPO FILE LIST — explore the repo and cite real paths only`
    );
  }

  return null;
}