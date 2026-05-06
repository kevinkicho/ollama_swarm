// #88 (2026-05-01) — extracted from MoaRunner.writeMoaDeliverable.
//
// Pure function + context-object pattern. The calling runner passes all
// dependencies as parameters; no `this` access at all.

import type { Agent } from "../services/AgentManager.js";
import type { TranscriptEntry } from "../types.js";
import type { AgentManager } from "../services/AgentManager.js";
import type { RepoService } from "../services/RepoService.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { DerivedRubric } from "./rubricPrePass.js";
import { writeDeliverable, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";

export interface MoaDeliverableContext {
  cfg: RunConfig;
  transcript: readonly TranscriptEntry[];
  derivedRubric: DerivedRubric | null;
  actualRoundsCompleted: number;
  manager: AgentManager;
  repos: RepoService;
  emit: (e: import("../types.js").SwarmEvent) => void;
  appendSystem: (text: string, summary?: import("../types.js").TranscriptEntrySummary) => void;
}

export async function writeMoaDeliverable(ctx: MoaDeliverableContext): Promise<void> {
  const { cfg } = ctx;
  if (!cfg.runId) return;

  const agentEntries = ctx.transcript.filter((e) => e.role === "agent");
  if (agentEntries.length === 0) return;
  const finalSynthesis = agentEntries[agentEntries.length - 1]?.text ?? "";

  const proposerCount = cfg.agentCount;
  const round1Proposers = agentEntries.slice(0, proposerCount);
  const baseSections = [
    {
      title: "Final synthesis",
      body: finalSynthesis.length > 0 ? finalSynthesis : "_(empty synthesis)_",
    },
    {
      title: `Round 1 — ${round1Proposers.length} independent proposer drafts`,
      body:
        round1Proposers.length > 0
          ? round1Proposers
              .map((e) => `### Proposer ${e.agentIndex ?? "?"}\n\n${e.text.trim()}`)
              .join("\n\n")
          : "_(no proposer drafts captured)_",
    },
  ];

  const allAgents = ctx.manager.list();
  const criticAgent = allAgents[allAgents.length - 1] ?? null;
  const sections = await runQualityPasses({
    baseSections,
    rubric: ctx.derivedRubric,
    criticAgent,
    manager: ctx.manager,
  });
  const result = writeDeliverable({
    preset: "moa",
    runId: cfg.runId,
    clonePath: cfg.localPath,
    title: "MoA synthesis",
    subtitle: `${proposerCount} proposer${proposerCount === 1 ? "" : "s"} + aggregator across ${ctx.actualRoundsCompleted} round${ctx.actualRoundsCompleted === 1 ? "" : "s"}`,
    sections,
  });
  if (result.ok) {
    ctx.appendSystem(`Deliverable saved → ${result.filename}`, {
      kind: "deliverable",
      preset: "moa",
      filename: result.filename,
      fullPath: result.fullPath,
      bytes: result.bytes,
      sectionTitles: sections.map((s) => s.title),
    });
  } else {
    ctx.appendSystem(`Failed to write deliverable (${result.reason})`);
  }

  // T2.2 (2026-05-04): opt-in wrap-up apply phase.
  const implementer = criticAgent ?? allAgents[0] ?? null;
  if (implementer) {
    const discussionContext = [
      `MoA synthesis (${proposerCount} proposers, ${ctx.actualRoundsCompleted} round${ctx.actualRoundsCompleted === 1 ? "" : "s"}):`,
      finalSynthesis.slice(0, 2000),
      "",
      "Key proposer drafts:",
      ...round1Proposers.slice(0, 5).map(
        (e) => `[Proposer ${e.agentIndex ?? "?"}] ${e.text.slice(0, 500)}…`
      ),
    ].join("\n");

    const relevantFiles: string[] = [];
    const filePattern = /(?:src\/|tests\/|lib\/|dist\/)[a-zA-Z0-9_./-]+\.(ts|js|tsx|jsx|py|rs|go)/g;
    for (const e of agentEntries.slice(0, proposerCount)) {
      const matches = e.text.match(filePattern) || [];
      for (const m of matches) {
        if (!relevantFiles.includes(m)) relevantFiles.push(m);
      }
    }

    await maybeRunWrapUpApply({
      cfg,
      presetName: "moa",
      agent: implementer,
      manager: ctx.manager,
      repos: ctx.repos,
      emit: ctx.emit,
      appendSystem: (text) => ctx.appendSystem(text),
      discussionContext,
      relevantFiles: relevantFiles.slice(0, 20),
    });
  }
}