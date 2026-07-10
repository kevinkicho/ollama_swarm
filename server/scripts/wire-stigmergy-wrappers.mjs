import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const path = join(__dirname, "../src/swarm/StigmergyRunner.ts");
let src = readFileSync(path, "utf8");

// --- imports ---
if (!src.includes("stigmergyTurns.js")) {
  // Replace heavy import block for import graph + seed helpers with extracted modules
  src = src.replace(
    `// T197 (2026-05-04): cross-cluster discovery via import graph.
import {
  buildImportGraph,
  relatedFilesViaImports,
  type ImportGraph,
} from "./importGraph.js";
import { detectExplorationGaps, formatExplorationGapsMarkdown } from "./stigmergyExplorationGap.js";

import { buildSeedSummary } from "./runSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";`,
    `import type { ImportGraph } from "./importGraph.js";
import { detectExplorationGaps, formatExplorationGapsMarkdown } from "./stigmergyExplorationGap.js";

import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { buildStigmergySeedMessage } from "./stigmergySeed.js";
import {
  applyAnnotation as applyAnnotationExtracted,
  spreadCrossClusterPheromones as spreadCrossClusterPheromonesExtracted,
  type StigmergyPheromoneHost,
} from "./stigmergyPheromones.js";
import {
  type StigmergyTurnsHost,
  runTerritoryPlanPass as runTerritoryPlanPassExtracted,
  runReportOutPass as runReportOutPassExtracted,
  runExplorerTurn as runExplorerTurnExtracted,
} from "./stigmergyTurns.js";`,
  );
}

// Slim prompt-helper imports (remove ones only used by extracted turns)
src = src.replace(
  `import {
  type AnnotationState,
  type ParsedAnnotation,
  SKIP_ENTRIES,
  PHEROMONE_DECAY_PER_ROUND,
  PHEROMONE_KINDS,
  type PheromoneKind,
  rankingScore,
  stripAnnotationEnvelope,
  parseAnnotation,
  buildExplorerPrompt,
  buildTerritoryPlanPrompt,
  parseTerritoryPlan,
  computeRankingSignature,
  buildHotFilesChainSection,
  formatAnnotations,
  describeSdkError,
} from "./stigmergyPromptHelpers.js";`,
  `import {
  type AnnotationState,
  type ParsedAnnotation,
  SKIP_ENTRIES,
  computeRankingSignature,
  formatAnnotations,
} from "./stigmergyPromptHelpers.js";`,
);

// seed method
src = src.replace(
  /private async seed\(clonePath: string, cfg: RunConfig\): Promise<void> \{[\s\S]*?\n  \}/,
  `private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    const { text, summary } = buildStigmergySeedMessage({ clonePath, cfg, tree });
    this.appendSystem(text, summary);
  }

  private pheromoneHost(): StigmergyPheromoneHost {
    return {
      annotations: this.annotations,
      round: this.round,
      active: this.active,
      importGraphCache: this.importGraphCache,
      setImportGraphCache: (g) => { this.importGraphCache = g; },
      emit: (e) => this.opts.emit(e),
      appendSystem: (t) => this.appendSystem(t),
      listRepoFiles: (p, o) => this.opts.repos.listRepoFiles(p, o),
    };
  }

  private stigmergyTurnsHost(): StigmergyTurnsHost {
    return {
      manager: this.opts.manager,
      emit: (e) => this.opts.emit(e),
      logDiag: this.opts.logDiag,
      transcript: this.transcript,
      annotations: this.annotations,
      territoryAssignments: this.territoryAssignments,
      round: this.round,
      active: this.active,
      stats: this.stats,
      getStopping: () => this.stopping,
      appendSystem: (t, s) => this.appendSystem(t, s as any),
      emitAgentState: (s) => this.emitAgentState(s),
      runAgent: (a, p, o) => this.runAgent(a, p, o),
      applyAnnotation: (ann) => this.applyAnnotation(ann),
    };
  }`,
);

// Replace territory through end of explorerTurn (before applyAnnotation)
const terrStart = src.indexOf("  private async runTerritoryPlanPass(");
const applyStart = src.indexOf("  private applyAnnotation(ann: ParsedAnnotation)");
if (terrStart < 0 || applyStart < 0) {
  throw new Error(`method markers ${terrStart} ${applyStart}`);
}

const thinMethods = `  private async runTerritoryPlanPass(
    cfg: RunConfig,
    agents: readonly Agent[],
    candidatePaths: readonly string[],
  ): Promise<void> {
    return runTerritoryPlanPassExtracted(this.stigmergyTurnsHost(), cfg, agents, candidatePaths);
  }

  private async runReportOutPass(): Promise<void> {
    return runReportOutPassExtracted(this.stigmergyTurnsHost());
  }

  private async runExplorerTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    candidatePaths: readonly string[],
  ): Promise<void> {
    return runExplorerTurnExtracted(
      this.stigmergyTurnsHost(),
      agent,
      round,
      totalRounds,
      candidatePaths,
    );
  }

`;

src = src.slice(0, terrStart) + thinMethods + src.slice(applyStart);

// Thin applyAnnotation + spreadCrossCluster
src = src.replace(
  /private applyAnnotation\(ann: ParsedAnnotation\): void \{[\s\S]*?\n  \}\n\n  private async spreadCrossClusterPheromones\([\s\S]*?\n  \}/,
  `private applyAnnotation(ann: ParsedAnnotation): void {
    applyAnnotationExtracted(this.pheromoneHost(), ann, {
      onHighInterest: (file, interest) => {
        void this.spreadCrossClusterPheromones(file, interest);
      },
    });
  }

  private async spreadCrossClusterPheromones(
    seedFile: string,
    seedInterest: number,
  ): Promise<void> {
    await spreadCrossClusterPheromonesExtracted(
      this.pheromoneHost(),
      seedFile,
      seedInterest,
    );
  }`,
);

// Drop unused imports if present
src = src.replace(/import \{ randomUUID \} from "node:crypto";\n/, "");
src = src.replace(/import \{ startSseAwareTurnWatchdog \} from "\.\/sseAwareTurnWatchdog\.js";\n/, "");
src = src.replace(/import \{ promptWithRetry \} from "\.\/promptWithRetry\.js";\n/, "");
src = src.replace(/import \{ promptWithFailoverAuto \} from "\.\/promptWithFailoverAuto\.js";\n/, "");
src = src.replace(/import \{ extractTextWithDiag, looksLikeJunk, trackPostRetryJunk \} from "\.\/extractText\.js";\n/, "");
src = src.replace(/import \{ retryEmptyResponse \} from "\.\/promptAndExtract\.js";\n/, "");
src = src.replace(/import \{ stripAgentText \} from "@ollama-swarm\/shared\/stripAgentText";\n/, "");
src = src.replace(/import \{ getAgentAddendum \} from "@ollama-swarm\/shared\/topology";\n/, "");

writeFileSync(path, src);
console.log("wired StigmergyRunner, lines", src.split("\n").length);
// sanity
if (src.includes("buildTerritoryPlanPrompt") || src.includes("buildExplorerPrompt")) {
  console.warn("still has prompt builders inline");
}
if (!src.includes("stigmergyTurns.js")) console.error("missing turns import");
if (!src.includes("stigmergySeed.js")) console.error("missing seed import");
if (!src.includes("stigmergyPheromones.js")) console.error("missing pheromones import");
