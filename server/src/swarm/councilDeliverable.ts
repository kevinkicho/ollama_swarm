// councilDeliverable.ts — Deliverable writing for Council preset
// Extracted from CouncilRunner.ts to keep LOC under 500 per file.

import type { Agent } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { TranscriptEntry } from "../types.js";
import type { DerivedRubric } from "./rubricPrePass.js";
import {
  readDirective,
  pickDeliverableTitle,
  pickAnswerSectionTitle,
  pickDeliverableSubtitle,
  maybeDirectiveSection,
} from "./directivePromptHelpers.js";
import { writeDeliverable, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";

export interface DeliverableContext {
  manager: { list: () => Agent[] };
  repos: { listTopLevel: (path: string) => Promise<string[]> };
  emit: (event: Record<string, unknown>) => void;
  appendSystem: (msg: string, summary?: Record<string, unknown>) => void;
}

export async function writeCouncilDeliverable(
  cfg: RunConfig,
  transcript: TranscriptEntry[],
  derivedRubric: DerivedRubric | null,
  round: number,
  earlyStopDetail: string | undefined,
  multiWriter: { isActive: () => boolean; proposalCount: () => number; getProposals: () => any[]; reconcile: (files: Record<string, string | null>, strategy: string) => Promise<any> } | undefined,
  ctx: DeliverableContext,
): Promise<void> {
  if (!cfg.runId) return;

  const dirCtx = readDirective(cfg);

  // Latest synthesis bubble
  const synthesisEntry = [...transcript]
    .reverse()
    .find((e) => e.summary?.kind === "council_synthesis");
  const synthesisText = synthesisEntry?.text ?? "_(synthesis missing)_";

  // Round 1 = independent drafts (peer-hidden)
  const round1Drafts = transcript.filter(
    (e) =>
      e.summary?.kind === "council_draft" &&
      e.summary.round === 1 &&
      e.role === "agent",
  );

  // Final round = revised drafts
  const finalRound = round;
  const finalDrafts = transcript.filter(
    (e) =>
      e.summary?.kind === "council_draft" &&
      e.summary.round === finalRound &&
      e.role === "agent",
  );

  // Per-agent latest position section — simplified
  const positionsBody = transcript
    .filter((e) => e.role === "agent" && e.summary?.kind === "council_draft")
    .slice(-cfg.agentCount)
    .map((e) => `### Agent ${e.agentIndex}\n\n${e.text.slice(0, 500)}`)
    .join("\n\n");
  const positionsSection = { title: "Per-agent positions (latest)", body: positionsBody || "_(no agent drafts found)_" };

  const baseSections: Array<{ title: string; body: string }> = [];
  const directiveSection = maybeDirectiveSection(dirCtx);
  if (directiveSection) baseSections.push(directiveSection);

  baseSections.push(
    {
      title: pickAnswerSectionTitle(dirCtx, {
        withDirective: "Answer to directive",
        withoutDirective: "Final synthesis",
      }),
      body: synthesisText,
    },
    positionsSection,
    {
      title: `Round ${finalRound} — final drafts (full text)`,
      body:
        finalDrafts.length > 0
          ? finalDrafts
              .map((e) => `### Agent ${e.agentIndex ?? "?"}\n\n${e.text.trim()}`)
              .join("\n\n")
          : "_(no final-round drafts captured)_",
    },
    {
      title: "Round 1 — independent first drafts (peer-hidden)",
      body:
        round1Drafts.length > 0
          ? round1Drafts
              .map((e) => `### Agent ${e.agentIndex ?? "?"}\n\n${e.text.trim()}`)
              .join("\n\n")
          : "_(no round 1 drafts captured)_",
    },
  );

  // Augment with rubric + critic notes + next-actions
  const lead = ctx.manager.list().find((a) => a.index === 1) ?? null;
  const sections = await runQualityPasses({
    baseSections,
    rubric: derivedRubric,
    criticAgent: lead,
    manager: ctx.manager,
  });

  const subtitleBase = `${cfg.agentCount} drafter${cfg.agentCount === 1 ? "" : "s"} across ${finalRound}/${cfg.rounds} round${cfg.rounds === 1 ? "" : "s"}${earlyStopDetail ? " · early-stop" : ""}`;
  const result = writeDeliverable({
    preset: "council",
    runId: cfg.runId,
    clonePath: cfg.localPath,
    title: pickDeliverableTitle(dirCtx, {
      withDirective: "Council: directive answer",
      withoutDirective: "Council synthesis",
    }),
    subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
    sections,
  });

  if (result.ok) {
    ctx.appendSystem(`Deliverable saved → ${result.filename}`, {
      kind: "deliverable",
      preset: "council",
      filename: result.filename,
      fullPath: result.fullPath,
      bytes: result.bytes,
      sectionTitles: sections.map((s) => s.title),
    });
  } else {
    ctx.appendSystem(`Failed to write deliverable (${result.reason})`);
  }

  // Opt-in wrap-up apply phase
  if (lead) {
    const synthesisEntry = transcript.find(
      (e) => e.summary?.kind === "council_synthesis",
    );
    const discussionContext = synthesisEntry
      ? [
          `Council synthesis after ${finalRound}/${cfg.rounds} round(s):`,
          synthesisEntry.text,
          "",
          "Key positions from agents:",
          ...transcript
            .filter((e) => e.role === "agent" && e.summary?.kind !== "council_synthesis")
            .slice(-cfg.agentCount * 2)
            .map((e) => `[Agent ${e.agentIndex ?? "?"}] ${e.text.slice(0, 500)}…`),
        ].join("\n")
      : undefined;

    const relevantFiles: string[] = [];
    const filePattern = /(?:src\/|tests\/|lib\/|dist\/)[a-zA-Z0-9_./-]+\.(ts|js|tsx|jsx|py|rs|go)/g;
    for (const e of transcript) {
      if (e.role !== "agent") continue;
      const matches = e.text.match(filePattern) || [];
      for (const m of matches) {
        if (!relevantFiles.includes(m)) relevantFiles.push(m);
      }
    }

    await maybeRunWrapUpApply({
      cfg,
      presetName: "council",
      agent: lead,
      manager: ctx.manager,
      repos: ctx.repos,
      emit: ctx.emit,
      appendSystem: (text) => ctx.appendSystem(text),
      discussionContext,
      relevantFiles: relevantFiles.slice(0, 20),
    });
  }

  // Multi-writer reconcile
  if (multiWriter?.isActive() && multiWriter.proposalCount() > 0) {
    const proposals = multiWriter.getProposals();
    ctx.appendSystem(
      `Multi-writer reconcile: ${proposals.length} proposal(s) from ${new Set(proposals.map((p: any) => p.agentId)).size} agent(s).`,
    );

    const currentFiles: Record<string, string | null> = {};
    const allFiles = new Set(proposals.flatMap((p: any) => p.hunks.map((h: any) => h.file)));
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

    const strategy = cfg.conflictPolicy ?? "vote";
    const reconcileResult = await multiWriter.reconcile(currentFiles, strategy);

    if (!reconcileResult.ok) {
      ctx.appendSystem(
        `Multi-writer reconcile: failed — ${reconcileResult.conflicts.length} conflict(s) detected.`,
      );
      for (const conflict of reconcileResult.conflicts.slice(0, 5)) {
        ctx.appendSystem(
          `  ${conflict.type} on ${conflict.file}: ${conflict.conflictingAgents.map((a: any) => `agent-${a.agentIndex}`).join(", ")}`,
        );
      }
    } else if (reconcileResult.hunks.length > 0) {
      ctx.appendSystem(
        `Multi-writer reconcile: ${reconcileResult.hunks.length} hunk(s) ready to apply (${strategy} strategy).`,
      );

      const { runWrapUpApplyPhase } = await import("./wrapUpApplyPhase.js");
      const applyResult = await runWrapUpApplyPhase({
        directive: cfg.userDirective ?? "Council multi-writer synthesis",
        clonePath: cfg.localPath,
        model: cfg.writeModel ?? cfg.model,
        agent: lead!,
        repos: ctx.repos,
        manager: ctx.manager,
        emit: ctx.emit,
        appendSystem: (text: string) => ctx.appendSystem(text),
        presetName: "council",
        verifyCommand: cfg.verifyCommand,
        hunksFromSynthesizer: reconcileResult.hunks,
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
}
