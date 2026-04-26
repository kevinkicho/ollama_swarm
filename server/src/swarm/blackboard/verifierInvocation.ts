// Task #164 (refactor): per-commit verifier invocation extracted from
// BlackboardRunner.ts. The original Task #128 docs:
//
// Per-commit verifier. Independent claim-checking gate sitting between
// critic-accept and disk-write. The critic asks "is this BUSYWORK?";
// the auditor asks "are contract criteria met across all commits?";
// the verifier asks the narrower per-commit question: "does THIS diff
// actually do what THIS todo asked for?". Catches the failure mode
// where a worker satisfies the critic with a plausible-looking diff
// that doesn't action its specific todo — wasting a commit slot the
// auditor only notices much later.
//
// Verdict semantics:
//   "verified" / "partial"  → accept
//   "unverifiable"          → accept + log warning
//   "false"                 → reject (markStale → replan)
//
// Failure-open everywhere — verifier is here to catch a real failure
// mode, not to grind the run on its own hiccups.

import type { Agent, AgentManager } from "../../services/AgentManager.js";
import type { TranscriptEntrySummary } from "../../types.js";
import {
  VERIFIER_SYSTEM_PROMPT,
  buildVerifierUserPrompt,
  parseVerifierResponse,
  type VerifierVerdict,
} from "./prompts/verifier.js";
import type { Board } from "./Board.js";
import type { Todo } from "./types.js";

// Truncate to 80 chars for log lines (matches BB.ts inline truncate).
function truncate(s: string, max: number = 80): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface VerifierContext {
  manager: AgentManager;
  board: Board;
  appendSystem: (text: string, summary?: TranscriptEntrySummary) => void;
  /** Set by BB.ts checkAndApplyCaps when a cap trips; the verifier
   *  short-circuits to accept once stopping=true so the runner can
   *  exit cleanly without waiting on this best-effort gate. */
  isStopping: () => boolean;
  /** Bump the proposing agent's rejected-work counter on a FALSE verdict.
   *  Wired into BlackboardRunner.rejectedAttemptsPerAgent. */
  bumpRejected: (agentId: string) => void;
}

export async function runVerifier(
  todo: Todo,
  proposingAgent: Agent,
  contentsBefore: Record<string, string | null>,
  resultingDiffs: ReadonlyArray<{ file: string; newText: string }>,
  ctx: VerifierContext,
): Promise<"accept" | "reject"> {
  const roster = ctx.manager.list();
  const planner = roster.find((a) => a.index === 1);
  if (!planner || planner.id === proposingAgent.id) {
    ctx.appendSystem(
      `[verifier] no planner peer to check ${proposingAgent.id}'s diff; skipping (accept-by-default).`,
    );
    return "accept";
  }
  const files = resultingDiffs.map((d) => ({
    file: d.file,
    before: contentsBefore[d.file] ?? null,
    after: d.newText,
  }));
  const userPrompt = buildVerifierUserPrompt({
    proposingAgentId: proposingAgent.id,
    todoDescription: todo.description,
    todoExpectedFiles: [...todo.expectedFiles],
    files,
  });
  const fullPrompt = `${VERIFIER_SYSTEM_PROMPT}\n\n${userPrompt}`;

  let sessionId: string;
  try {
    const created = await planner.client.session.create({
      body: { title: `verifier-${todo.id}-${Date.now()}` },
    });
    const any = created as { data?: { id?: string; info?: { id?: string } }; id?: string };
    const sid = any?.data?.id ?? any?.data?.info?.id ?? any?.id;
    if (!sid) throw new Error("session.create returned no session id");
    sessionId = sid;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(
      `[verifier] failed to open fresh session on ${planner.id} (${msg}). Accepting by default (failure-open).`,
    );
    return "accept";
  }

  let responseText: string;
  try {
    const res = await planner.client.session.prompt({
      path: { id: sessionId },
      body: {
        agent: "swarm-read",
        model: { providerID: "ollama", modelID: planner.model },
        parts: [{ type: "text", text: fullPrompt }],
      },
    });
    const any = res as {
      data?: {
        parts?: Array<{ type?: string; text?: string }>;
        info?: { parts?: Array<{ type?: string; text?: string }> };
        text?: string;
      };
    };
    const parts = any?.data?.parts ?? any?.data?.info?.parts;
    if (Array.isArray(parts)) {
      const texts = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string);
      responseText = texts.length ? texts.join("\n") : (any?.data?.text ?? "");
    } else {
      responseText = any?.data?.text ?? "";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(
      `[verifier] prompt failed on ${planner.id} (${msg}). Accepting by default (failure-open).`,
    );
    return "accept";
  }
  if (ctx.isStopping()) return "accept";

  const parsed = parseVerifierResponse(responseText);
  if (!parsed.ok) {
    ctx.appendSystem(
      `[verifier] response did not parse (${parsed.reason}). Accepting by default (failure-open).`,
    );
    return "accept";
  }
  const verdict: VerifierVerdict = parsed.verifier.verdict;
  const cite = parsed.verifier.evidenceCitation;
  const rat = parsed.verifier.rationale ? ` — ${parsed.verifier.rationale}` : "";
  // Task #151: structured tag so the UI ribbon renders cleanly. Same
  // text payload as before for back-compat with any plain-text
  // consumer; the summary kind drives the visual rendering.
  const summary: TranscriptEntrySummary = {
    kind: "verifier_verdict",
    verdict,
    proposingAgentId: proposingAgent.id,
    todoDescription: todo.description,
    evidenceCitation: cite,
    rationale: parsed.verifier.rationale,
  };
  if (verdict === "false") {
    ctx.board.markStale(
      todo.id,
      `verifier rejected (${planner.id}): ${cite}${rat}`,
    );
    ctx.appendSystem(
      `[verifier] ${planner.id} FALSE on ${proposingAgent.id}'s diff for "${truncate(todo.description)}": ${cite}${rat}`,
      summary,
    );
    ctx.bumpRejected(proposingAgent.id);
    return "reject";
  }
  if (verdict === "unverifiable") {
    ctx.appendSystem(
      `[verifier] ${planner.id} UNVERIFIABLE on ${proposingAgent.id}'s diff for "${truncate(todo.description)}": ${cite}${rat} — accepting (failure-open).`,
      summary,
    );
    return "accept";
  }
  // verified or partial → accept
  ctx.appendSystem(
    `[verifier] ${planner.id} ${verdict.toUpperCase()} ${proposingAgent.id}'s diff: ${cite}${rat}`,
    summary,
  );
  return "accept";
}
