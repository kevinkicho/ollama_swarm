import { execSync } from "node:child_process";

let cached: boolean | undefined;

/** True when `git` is on PATH — git-backed integration tests skip otherwise. */
export function isGitAvailable(): boolean {
  if (cached !== undefined) return cached;
  try {
    execSync("git --version", { stdio: "ignore" });
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}