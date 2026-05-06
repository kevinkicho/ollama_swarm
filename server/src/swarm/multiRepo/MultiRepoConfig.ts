// Direction 7 Phase 1: multi-repo configuration.
//
// Extends RunConfig to support multiple repos. The orchestrator clones
// each repo to a separate directory, and agents see a repo map that
// tells them which repo owns which paths. Hunks are scoped by repo.

import type { PresetId } from "../SwarmRunner.js";

export interface RepoConfig {
  url: string;
  name: string;
  role: "primary" | "dependency" | "target";
  branch?: string;
  pathMapping?: Record<string, string>;
}

export interface MultiRepoRunConfig {
  repos: RepoConfig[];
  primaryRepo: string;
}

export function validateMultiRepoConfig(config: MultiRepoRunConfig): string | null {
  if (!config.repos || config.repos.length === 0) return "At least one repo is required";
  if (config.repos.length > 5) return "Maximum 5 repos per run";

  const names = new Set<string>();
  for (const repo of config.repos) {
    if (!repo.url) return `Repo "${repo.name}" missing url`;
    if (!repo.name) return "Repo name is required";
    if (names.has(repo.name)) return `Duplicate repo name: ${repo.name}`;
    if (repo.name.includes("/")) return `Repo name cannot contain "/": ${repo.name}`;
    names.add(repo.name);
  }

  const primaries = config.repos.filter((r) => r.role === "primary");
  if (primaries.length !== 1) return "Exactly one repo must have role='primary'";

  return null;
}

export function buildRepoMapPrompt(repos: RepoConfig[]): string {
  if (repos.length <= 1) return "";
  const lines: string[] = [
    "=== MULTI-REPO CONFIGURATION ===",
    `This run operates across ${repos.length} repositories. When editing files, prefix the path with the repo name.`,
    "",
  ];
  for (const repo of repos) {
    lines.push(`[${repo.name}] (${repo.role}) — ${repo.url}${repo.branch ? ` @ ${repo.branch}` : ""}`);
  }
  lines.push("", "Example path: backend/src/auth.ts (where 'backend' is the repo name)");
  lines.push("Always use the repo-name/ prefix when referencing or editing files.");
  return lines.join("\n");
}

export function parseRepoPath(path: string, repos: RepoConfig[]): { repoName: string; relativePath: string } | null {
  if (repos.length <= 1) {
    return { repoName: repos[0]?.name ?? "primary", relativePath: path };
  }
  const firstSlash = path.indexOf("/");
  if (firstSlash === -1) return null;
  const repoName = path.slice(0, firstSlash);
  const relativePath = path.slice(firstSlash + 1);
  if (!repos.some((r) => r.name === repoName)) return null;
  return { repoName, relativePath };
}