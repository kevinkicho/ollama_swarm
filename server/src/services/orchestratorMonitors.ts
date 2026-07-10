// Conformance + embedding-drift monitor setup — extracted from Orchestrator.

import type { RunConfig } from "../swarm/SwarmRunner.js";
import type { ActiveRun } from "./ActiveRun.js";
import { ConformanceMonitor } from "./ConformanceMonitor.js";
import { EmbeddingDriftMonitor } from "./EmbeddingDriftMonitor.js";
import type { RepoService } from "./RepoService.js";
import type { SwarmEvent } from "../types.js";
import { config } from "../config.js";

export interface SetupMonitorsOpts {
  activeRun: ActiveRun;
  runId: string;
  trimmedDirective: string | undefined;
  cfg: RunConfig;
  ollamaBaseUrl: string | undefined;
  emit: (e: SwarmEvent) => void;
  repos: RepoService;
}

/** Attach conformance + drift monitors when directive + env allow. */
export function setupConformanceAndDriftMonitors(opts: SetupMonitorsOpts): void {
  const {
    activeRun,
    runId,
    trimmedDirective,
    cfg,
    ollamaBaseUrl,
    emit,
    repos,
  } = opts;
  if (
    !trimmedDirective ||
    trimmedDirective.length === 0 ||
    !config.CONFORMANCE_MONITOR ||
    !ollamaBaseUrl
  ) {
    return;
  }
  const baseUrl = ollamaBaseUrl;
  void (async () => {
    let anchors: import("../projectGraph/types.js").ProjectGraphAnchors | undefined;
    if (config.PROJECT_GRAPH_ENABLED && cfg.localPath) {
      try {
        const { readProjectGraphSidecar } = await import("../projectGraph/sidecar.js");
        const sidecar = await readProjectGraphSidecar(cfg.localPath);
        if (sidecar) anchors = sidecar.anchors;
      } catch {
        // best-effort
      }
    }

    const monitor = new ConformanceMonitor({
      runId,
      directive: trimmedDirective,
      ollamaBaseUrl: baseUrl,
      graderModel: cfg.model,
      getTranscript: () => activeRun.runner.status().transcript ?? [],
      getPhase: () => activeRun.runner.status().phase ?? "idle",
      emit,
      isActive: () => activeRun.runner.isRunning(),
      anchors,
      getTouchedPaths:
        cfg.localPath && anchors
          ? async () => {
              const localPath = cfg.localPath;
              try {
                const gs = await repos.gitStatus(localPath);
                const { extractDeliverables } = await import(
                  "../swarm/blackboard/summary.js"
                );
                const d = extractDeliverables(gs.porcelain);
                return d?.map((x) => x.path) ?? [];
              } catch {
                return [];
              }
            }
          : undefined,
    });
    activeRun.attachMonitors(monitor);
    monitor.start();

    const drift = new EmbeddingDriftMonitor({
      runId,
      directive: trimmedDirective,
      ollamaBaseUrl: baseUrl,
      getTranscript: () => activeRun.runner.status().transcript ?? [],
      emit,
      isActive: () => activeRun.runner.isRunning(),
    });
    activeRun.attachMonitors(undefined, drift);
    void drift.start();
  })();
}
