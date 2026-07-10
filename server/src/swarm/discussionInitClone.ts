// Clone + spawn pipeline — extracted from DiscussionRunnerBase.initCloneAndSpawn.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { SwarmEvent, SwarmPhase, TranscriptEntrySummary } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { RepoService } from "../services/RepoService.js";
import { buildAgentsReadySummary } from "./agentsReadySummary.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { resolveRunSpawnModel } from "./resolveRunSpawnModel.js";
export interface CloneSpawnResult {
  destPath: string;
  ready: Agent[];
}

export interface CloneSpawnOpts {
  /** Preset name for the agentsReady summary */
  preset: string;
  /** If provided, override the minimum agent count check (default: 1) */
  minAgents?: number;
  /** Role label resolver for each agent */
  roleResolver: (agent: Agent) => string;
  /** Extra line appended to the "N agents ready" message (preset-specific context) */
  extraReadyMessage?: string;
}

export interface DiscussionInitCloneHost {
  repos: RepoService;
  manager: AgentManager;
  emit: (e: SwarmEvent) => void;
  setPhase: (p: SwarmPhase) => void;
  appendSystem: (text: string, summary?: TranscriptEntrySummary) => void;
}

/**
 * Clone the repo, exclude artifacts, spawn agents, validate + register.
 * Returns `{ destPath, ready }` for the subclass to continue setup.
 */
export async function initCloneAndSpawn(
  host: DiscussionInitCloneHost,
  cfg: RunConfig,
  spawnOpts: CloneSpawnOpts,
): Promise<CloneSpawnResult> {
  // Skip "cloning" phase for direct local paths (no git clone will occur).
  const isRemoteClone = !!(
    cfg.repoUrl &&
    (cfg.repoUrl.startsWith("http://") || cfg.repoUrl.startsWith("https://"))
  );
  if (isRemoteClone) {
    host.setPhase("cloning");
  }
  let cloneResult: import("../services/RepoService.js").CloneResult;
  // Local folder path — skip clone, use the directory directly.
  if (!cfg.repoUrl.startsWith("http://") && !cfg.repoUrl.startsWith("https://")) {
    cloneResult = {
      destPath: cfg.localPath,
      alreadyPresent: true,
      priorCommits: 0,
      priorChangedFiles: 0,
      priorUntrackedFiles: 0,
    };
  } else {
    cloneResult = await host.repos.clone({ url: cfg.repoUrl, destPath: cfg.localPath });
  }
  const { destPath } = cloneResult;
  const gitInit = await host.repos.ensureGitRepo(destPath);
  if (gitInit.initialized) {
    host.appendSystem("[clone] Initialized git repository in local workspace.");
  }
  host.emit({
    type: "clone_state",
    alreadyPresent: cloneResult.alreadyPresent,
    clonePath: destPath,
    priorCommits: cloneResult.priorCommits ?? 0,
    priorChangedFiles: cloneResult.priorChangedFiles ?? 0,
    priorUntrackedFiles: cloneResult.priorUntrackedFiles ?? 0,
  });
  await host.repos.excludeRunnerArtifacts(destPath);
  host.appendSystem(formatCloneMessage(cfg.repoUrl, destPath, cloneResult));

  host.setPhase("spawning");
  const spawnStart = Date.now();
  const spawnTasks: Promise<Agent>[] = [];
  for (let i = 1; i <= cfg.agentCount; i++) {
    const model = resolveRunSpawnModel(cfg, i);
    spawnTasks.push(host.manager.spawnAgentNoOpencode({ cwd: destPath, index: i, model }));
  }
  const results = await Promise.allSettled(spawnTasks);
  const ready = results
    .filter((r): r is PromiseFulfilledResult<Agent> => r.status === "fulfilled")
    .map((r) => r.value);

  const minAgents = spawnOpts.minAgents ?? 1;
  if (ready.length < minAgents) {
    if (minAgents === 1) {
      throw new Error("No agents started successfully");
    }
    throw new Error(
      `${spawnOpts.preset} requires at least ${minAgents} agents, but only ${ready.length} started.`,
    );
  }

  const modelList = ready.map((a) => a.model).join(", ");
  const extra = spawnOpts.extraReadyMessage ? ` ${spawnOpts.extraReadyMessage}` : "";
  host.appendSystem(
    `${ready.length}/${cfg.agentCount} agents ready — models: ${modelList}.${extra}`,
    buildAgentsReadySummary({
      manager: host.manager,
      preset: spawnOpts.preset,
      ready,
      requestedCount: cfg.agentCount,
      spawnElapsedMs: Date.now() - spawnStart,
      roleResolver: spawnOpts.roleResolver,
    }),
  );

  return { destPath, ready };
}
