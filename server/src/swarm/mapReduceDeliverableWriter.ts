import type { Agent } from "../services/AgentManager.js";
import type { SwarmEvent, TranscriptEntry } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { MultiWriterState } from "./multiWriterState.js";
import { writeDeliverableAndEmit, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { readDirective, pickDeliverableTitle, pickAnswerSectionTitle, pickDeliverableSubtitle, maybeDirectiveSection } from "./directivePromptHelpers.js";
import type { PerAgentStat } from "./blackboard/summary.js";

export interface MapReduceDeliverableContext {
  cfg: RunConfig;
  transcript: TranscriptEntry[];
  round: number;
  earlyStopDetail?: string;
  manager: { list(): Agent[] };
  repos: import("../services/RepoService.js").RepoService;
  emit: (event: SwarmEvent) => void;
  appendSystem: (text: string) => void;
  multiWriter?: MultiWriterState;
  stats: { buildPerAgentStats(): PerAgentStat[] };
  stopping: boolean;
  summaryWritten: boolean;
  startedAt?: number;
}

export async function writeMapReduceDeliverableImpl(ctx: MapReduceDeliverableContext): Promise<void> {
  const { cfg } = ctx;
  if (!cfg.runId) return;

  const dirCtx = readDirective(cfg);
  const reducerSynthesis = [...ctx.transcript]
    .reverse()
    .find((e) => e.summary?.kind === "mapreduce_synthesis");
  const mapperEntries = ctx.transcript.filter(
    (e) => e.role === "agent" && e.agentIndex !== 1,
  );
  const sections: Array<{ title: string; body: string }> = [];
  const directiveSection = maybeDirectiveSection(dirCtx);
  if (directiveSection) sections.push(directiveSection);
  sections.push(
    {
      title: pickAnswerSectionTitle(dirCtx, {
        withDirective: "Answer to directive",
        withoutDirective: "Final reducer synthesis",
      }),
      body: reducerSynthesis?.text?.trim() || "_(no reducer synthesis captured)_",
    },
    {
      title: `Per-mapper findings (${mapperEntries.length} entries)`,
      body:
        mapperEntries.length > 0
          ? mapperEntries
              .map((e) => `### Mapper ${e.agentIndex ?? "?"}\n\n${e.text.trim()}`)
              .join("\n\n")
          : "_(no mapper findings)_",
    },
  );
  const reducer = ctx.manager.list().find((a) => a.index === 1) ?? null;
  const augmented = await runQualityPasses({
    baseSections: sections,
    rubric: null,
    criticAgent: reducer,
    manager: ctx.manager as import("../services/AgentManager.js").AgentManager,
  });
  const subtitleBase = `1 reducer + ${cfg.agentCount - 1} mappers across ${ctx.round}/${cfg.rounds} cycle${cfg.rounds === 1 ? "" : "s"}${ctx.earlyStopDetail ? " · early-stop" : ""}`;
  writeDeliverableAndEmit(
    {
      preset: "map-reduce",
      runId: cfg.runId,
      clonePath: cfg.localPath,
      title: pickDeliverableTitle(dirCtx, {
        withDirective: "Map-reduce: directive answer",
        withoutDirective: "Map-reduce report",
      }),
      subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
      sections: augmented,
    },
    { transcript: ctx.transcript, emit: ctx.emit },
  );

  if (reducer) {
    const mapperCount = cfg.agentCount - 1;
    const agentEntries = ctx.transcript.filter((e) => e.role === "agent");
    const reducerSynthesis2 = agentEntries.find(
      (e) => e.agentIndex === 1 && ctx.transcript.indexOf(e) > mapperCount
    );
    const mapperFindings = agentEntries.filter(
      (e) => e.agentIndex !== 1
    );

    const discussionContext = reducerSynthesis2 ? [
      `Map-reduce synthesis (1 reducer + ${mapperCount} mappers, ${ctx.round}/${cfg.rounds} cycle${cfg.rounds === 1 ? "" : "s"}):`,
      reducerSynthesis2.text.slice(0, 2000),
      "",
      "Key mapper findings:",
      ...mapperFindings.slice(0, 5).map(
        (e) => `[Mapper ${e.agentIndex}] ${e.text.slice(0, 400)}…`
      ),
    ].join("\n") : undefined;

    const relevantFiles: string[] = [];
    const filePattern = /(?:src\/|tests\/|lib\/|dist\/)[a-zA-Z0-9_./-]+\.(ts|js|tsx|jsx|py|rs|go)/g;
    for (const e of mapperFindings.slice(0, 10)) {
      const matches = e.text.match(filePattern) || [];
      for (const m of matches) {
        if (!relevantFiles.includes(m)) relevantFiles.push(m);
      }
    }

    if (ctx.multiWriter?.isActive() && ctx.multiWriter.proposalCount() > 0) {
      const proposals = ctx.multiWriter.getProposals();
      ctx.appendSystem(
        `Multi-writer reconcile: ${proposals.length} proposal(s) from ${new Set(proposals.map(p => p.agentId)).size} agent(s).`,
      );

      const currentFiles: Record<string, string | null> = {};
      const allFiles = new Set(proposals.flatMap(p => p.hunks.map(h => h.file)));
      for (const file of allFiles) {
        try {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const absPath = path.join(cfg.localPath, file);
          currentFiles[file] = await fs.readFile(absPath, "utf8");
        } catch {
          currentFiles[file] = null;
        }
      }

      const strategy = cfg.conflictPolicy ?? "merge";
      const result = await ctx.multiWriter.reconcile(currentFiles, strategy);

      if (!result.ok) {
        ctx.appendSystem(
          `Multi-writer reconcile: failed — ${result.conflicts.length} conflict(s) detected.`,
        );
        for (const conflict of result.conflicts.slice(0, 5)) {
          ctx.appendSystem(
            `  ${conflict.type} on ${conflict.file}: ${conflict.conflictingAgents.map(a => `agent-${a.agentIndex}`).join(", ")}`,
          );
        }
      } else if (result.hunks.length > 0) {
        ctx.appendSystem(
          `Multi-writer reconcile: ${result.hunks.length} hunk(s) ready to apply (${strategy} strategy).`,
        );

        const { runWrapUpApplyPhase } = await import("./wrapUpApplyPhase.js");
        const applyResult = await runWrapUpApplyPhase({
          directive: cfg.userDirective ?? "Map-reduce multi-writer synthesis",
          clonePath: cfg.localPath,
          model: cfg.writeModel ?? cfg.model,
          agent: reducer!,
          repos: ctx.repos,
          manager: ctx.manager as import("../services/AgentManager.js").AgentManager,
          emit: ctx.emit,
          appendSystem: ctx.appendSystem,
          presetName: "map-reduce",
          verifyCommand: cfg.verifyCommand,
          hunksFromSynthesizer: result.hunks,
        });

        if (applyResult.ok) {
          ctx.appendSystem(
            `Multi-writer apply: ${applyResult.hunksApplied}/${applyResult.hunksAttempted} hunk(s) committed (${applyResult.commitSha?.slice(0, 7)}).`,
          );
        } else {
          ctx.appendSystem(
            `Multi-writer apply: failed — ${applyResult.reason}`,
          );
        }
      } else {
        ctx.appendSystem(`Multi-writer reconcile: 0 hunks to apply.`);
      }
    }

    await maybeRunWrapUpApply({
      cfg,
      presetName: "map-reduce",
      agent: reducer,
      manager: ctx.manager as import("../services/AgentManager.js").AgentManager,
      repos: ctx.repos,
      emit: ctx.emit,
      appendSystem: ctx.appendSystem,
      discussionContext,
      relevantFiles: relevantFiles.slice(0, 20),
    });
  }
}