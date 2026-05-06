import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { RepoService } from "../services/RepoService.js";
import type { SwarmEvent, TranscriptEntry, TranscriptEntrySummary } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { DerivedProposition } from "./propositionDerive.js";
import type { MultiWriterState } from "./multiWriterState.js";
import { writeDeliverableAndEmit, runQualityPasses } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { maybeDirectiveSection, pickDeliverableTitle, pickDeliverableSubtitle } from "./directivePromptHelpers.js";
import { readDirective } from "./directivePromptHelpers.js";

export interface WriteDebateDeliverableContext {
  cfg: RunConfig;
  transcript: readonly TranscriptEntry[];
  proposition?: string;
  derivedPropositionMeta?: DerivedProposition | null;
  earlyStopDetail?: string;
  multiWriter?: MultiWriterState;
  manager: AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
  appendSystem: (text: string, summary?: TranscriptEntrySummary) => void;
}

export async function writeDebateDeliverable(ctx: WriteDebateDeliverableContext): Promise<void> {
  const {
    cfg,
    transcript,
    proposition,
    derivedPropositionMeta,
    earlyStopDetail,
    multiWriter,
    manager,
    repos,
    emit,
    appendSystem,
  } = ctx;
  if (!cfg.runId) return;
  const dirCtx = readDirective(cfg);
  const proTurns = transcript.filter(
    (e) => e.summary?.kind === "debate_turn" && e.summary.role === "pro",
  );
  const conTurns = transcript.filter(
    (e) => e.summary?.kind === "debate_turn" && e.summary.role === "con",
  );
  const verdictEntry = [...transcript]
    .reverse()
    .find((e) => e.summary?.kind === "debate_verdict");
  const verdict = verdictEntry?.summary?.kind === "debate_verdict" ? verdictEntry.summary : null;
  const sections: Array<{ title: string; body: string }> = [];
  const directiveSection = maybeDirectiveSection(dirCtx);
  if (directiveSection) sections.push(directiveSection);
  const propositionLabel = derivedPropositionMeta
    ? derivedPropositionMeta.derived
      ? "Proposition (auto-derived from directive)"
      : "Proposition (fallback — auto-derive failed)"
    : "Proposition";
  sections.push(
    {
      title: propositionLabel,
      body: proposition?.trim() || dirCtx.directive || "_(no proposition)_",
    },
    {
      title: "Judge verdict",
      body: verdict
        ? `**Winner: ${verdict.winner.toUpperCase()}** · confidence ${verdict.confidence}\n\n` +
          `- PRO strongest: ${verdict.proStrongest}\n` +
          `- CON strongest: ${verdict.conStrongest}\n` +
          `- Decisive: ${verdict.decisive}\n` +
          `- Next action: ${verdict.nextAction}`
        : "_(no verdict captured)_",
    },
  );
  if (verdict && verdict.winner !== "tie") {
    const loserSide = verdict.winner === "pro" ? "CON" : "PRO";
    const loserStrongest =
      verdict.winner === "pro" ? verdict.conStrongest : verdict.proStrongest;
    const trimmed = loserStrongest?.trim() ?? "";
    sections.push({
      title: "Known risks (preserved from the losing side)",
      body:
        trimmed.length > 0
          ? `Even though ${verdict.winner.toUpperCase()} won, ${loserSide}'s strongest argument identified a real concern that the implementer should keep in mind:\n\n> ${trimmed}\n\nIf you act on the verdict's nextAction, do so with this objection consciously addressed — not dismissed.`
          : `_(${loserSide}'s strongest argument was empty; no preserved risk to surface.)_`,
    });
  }
  sections.push(
    {
      title: `PRO arguments (${proTurns.length} round${proTurns.length === 1 ? "" : "s"})`,
      body: proTurns.length > 0
        ? proTurns.map((e, i) => `### Round ${i + 1}\n\n${e.text.trim()}`).join("\n\n")
        : "_(no PRO turns)_",
    },
    {
      title: `CON arguments (${conTurns.length} round${conTurns.length === 1 ? "" : "s"})`,
      body: conTurns.length > 0
        ? conTurns.map((e, i) => `### Round ${i + 1}\n\n${e.text.trim()}`).join("\n\n")
        : "_(no CON turns)_",
    },
  );
  const judge = manager.list().find((a) => a.index === 3) ?? null;
  const augmented = await runQualityPasses({
    baseSections: sections,
    rubric: null,
    criticAgent: judge,
    manager,
  });
  const subtitleBase = `${proTurns.length} PRO + ${conTurns.length} CON rounds${earlyStopDetail ? " · early-stop" : ""}`;
  writeDeliverableAndEmit(
    {
      preset: "debate-judge",
      runId: cfg.runId,
      clonePath: cfg.localPath,
      title: pickDeliverableTitle(dirCtx, {
        withDirective: "Debate-judge: directive decision",
        withoutDirective: "Debate verdict",
      }),
      subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
      sections: augmented,
    },
    { transcript: transcript as TranscriptEntry[], emit },
  );

  if (judge) {
    const proTurns = transcript.filter(
      (e) => e.role === "agent" && e.summary && ('role' in e.summary) && e.summary.role === "pro"
    );
    const conTurns = transcript.filter(
      (e) => e.role === "agent" && e.summary && ('role' in e.summary) && e.summary.role === "con"
    );
    const verdictEntry = transcript.find(
      (e) => e.role === "agent" && e.summary?.kind === "debate_verdict"
    );

    const discussionContext = verdictEntry ? [
      `Debate verdict (${proTurns.length} PRO, ${conTurns.length} CON turns):`,
      verdictEntry.text.slice(0, 2000),
      "",
      "Key PRO arguments:",
      ...proTurns.slice(-2).map((e) => e.text.slice(0, 400)),
      "",
      "Key CON arguments:",
      ...conTurns.slice(-2).map((e) => e.text.slice(0, 400)),
    ].join("\n") : undefined;

    const relevantFiles: string[] = [];
    const filePattern = /(?:src\/|tests\/|lib\/|dist\/)[a-zA-Z0-9_./-]+\.(ts|js|tsx|jsx|py|rs|go)/g;
    for (const e of [...proTurns.slice(-3), ...conTurns.slice(-3)]) {
      const matches = e.text.match(filePattern) || [];
      for (const m of matches) {
        if (!relevantFiles.includes(m)) relevantFiles.push(m);
      }
    }

    if (multiWriter?.isActive() && multiWriter.proposalCount() > 0) {
      const proposals = multiWriter.getProposals();
      appendSystem(
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

      const strategy = cfg.conflictPolicy ?? "judge";
      const result = await multiWriter.reconcile(currentFiles, strategy);

      if (!result.ok) {
        appendSystem(
          `Multi-writer reconcile: failed — ${result.conflicts.length} conflict(s) detected.`,
        );
        for (const conflict of result.conflicts.slice(0, 5)) {
          appendSystem(
            `  ${conflict.type} on ${conflict.file}: ${conflict.conflictingAgents.map(a => `agent-${a.agentIndex}`).join(", ")}`,
          );
        }
      } else if (result.hunks.length > 0) {
        appendSystem(
          `Multi-writer reconcile: ${result.hunks.length} hunk(s) ready to apply (${strategy} strategy).`,
        );

        const { runWrapUpApplyPhase } = await import("./wrapUpApplyPhase.js");
        const applyResult = await runWrapUpApplyPhase({
          directive: cfg.userDirective ?? "Debate-judge multi-writer synthesis",
          clonePath: cfg.localPath,
          model: cfg.writeModel ?? cfg.model,
          agent: judge!,
          repos,
          manager,
          emit,
          appendSystem,
          presetName: "debate-judge",
          verifyCommand: cfg.verifyCommand,
          hunksFromSynthesizer: result.hunks,
        });

        if (applyResult.ok) {
          appendSystem(
            `Multi-writer apply: ${applyResult.hunksApplied}/${applyResult.hunksAttempted} hunk(s) committed (${applyResult.commitSha?.slice(0, 7)}).`,
          );
        } else {
          appendSystem(
            `Multi-writer apply: failed — ${applyResult.reason}`,
          );
        }
      } else {
        appendSystem(`Multi-writer reconcile: 0 hunks to apply.`);
      }
    }

    await maybeRunWrapUpApply({
      cfg,
      presetName: "debate-judge",
      agent: judge,
      manager,
      repos,
      emit,
      appendSystem,
      discussionContext,
      relevantFiles: relevantFiles.slice(0, 20),
    });
  }
}