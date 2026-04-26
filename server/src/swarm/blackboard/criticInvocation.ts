// Task #164 (refactor): per-commit critic invocation extracted from
// BlackboardRunner.ts.
//
// Two flavors share most of their shape:
//   - Single substance critic (the original Unit 35 behavior).
//   - Critic ensemble (Unit 60): substance + regression + consistency
//     fan out in parallel; majority vote across SUCCESSFUL responses;
//     1-1 ties (one abstain) tie-break to substance.
//
// Failure-open at every layer — critic infra hiccups never block
// real worker output. Lane-level failure becomes "abstain" so the
// ensemble votes on whatever came back; ensemble-level all-fail
// becomes "accept".
//
// Single critic runs on a FRESH session on the planner's client to
// avoid the worker-session contamination + UI-dup bugs that the
// original peer-session approach hit during the 2026-04-23 smoke.

import type { Agent, AgentManager } from "../../services/AgentManager.js";
import type { TranscriptEntrySummary } from "../../types.js";
import {
  buildCriticRepairPrompt,
  buildCriticUserPrompt,
  CRITIC_SYSTEM_PROMPT,
  REGRESSION_CRITIC_SYSTEM_PROMPT,
  CONSISTENCY_CRITIC_SYSTEM_PROMPT,
  SUBSTANCE_CRITIC_NAME,
  REGRESSION_CRITIC_NAME,
  CONSISTENCY_CRITIC_NAME,
  type CriticSeedFileBeforeAfter,
  type CriticSeedPriorCommit,
  parseCriticResponse,
} from "./prompts/critic.js";
import type { Board } from "./Board.js";
import type { ExitContract, Todo } from "./types.js";
import { truncate } from "./truncate.js";

export interface CriticContext {
  manager: AgentManager;
  board: Board;
  /** Used to find the linked criterion for prompt-grounding. Pass an empty
   *  array (or undefined contract) when no contract is on file. */
  contractCriteria: ExitContract["criteria"];
  appendSystem: (text: string, summary?: TranscriptEntrySummary) => void;
  isStopping: () => boolean;
  bumpRejected: (agentId: string) => void;
  /** Drives single-vs-ensemble dispatch. */
  ensembleEnabled: boolean;
}

export async function runCritic(
  todo: Todo,
  proposingAgent: Agent,
  contentsBefore: Record<string, string | null>,
  resultingDiffs: ReadonlyArray<{ file: string; newText: string }>,
  ctx: CriticContext,
): Promise<"accept" | "reject"> {
  const roster = ctx.manager.list();
  const planner = roster.find((a) => a.index === 1);
  if (!planner || planner.id === proposingAgent.id) {
    ctx.appendSystem(
      `[critic] no planner peer available to review ${proposingAgent.id}'s diff; skipping (accept-by-default).`,
    );
    return "accept";
  }

  const linkedCriterion = todo.criterionId
    ? ctx.contractCriteria.find((c) => c.id === todo.criterionId)
    : undefined;

  const files: CriticSeedFileBeforeAfter[] = resultingDiffs.map((d) => ({
    file: d.file,
    before: contentsBefore[d.file] ?? null,
    after: d.newText,
  }));

  const recentCommits: CriticSeedPriorCommit[] = ctx.board
    .listTodos()
    .filter((t) => t.status === "committed")
    .sort((a, b) => (b.committedAt ?? 0) - (a.committedAt ?? 0))
    .slice(0, 16)
    .map((t) => ({
      todoId: t.id,
      description: t.description,
      files: [...t.expectedFiles],
    }));

  const userPrompt = buildCriticUserPrompt({
    proposingAgentId: proposingAgent.id,
    todoDescription: todo.description,
    todoExpectedFiles: [...todo.expectedFiles],
    criterionId: linkedCriterion?.id,
    criterionDescription: linkedCriterion?.description,
    files,
    recentCommits,
  });

  if (ctx.ensembleEnabled) {
    return runCriticEnsemble(planner, proposingAgent, todo, userPrompt, ctx);
  }
  const fullPrompt = `${CRITIC_SYSTEM_PROMPT}\n\n${userPrompt}`;

  let sessionId: string;
  try {
    const created = await planner.client.session.create({
      body: { title: `critic-${todo.id}-${Date.now()}` },
    });
    const any = created as { data?: { id?: string; info?: { id?: string } }; id?: string };
    const sid = any?.data?.id ?? any?.data?.info?.id ?? any?.id;
    if (!sid) throw new Error("session.create returned no session id");
    sessionId = sid;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(
      `[critic] failed to open fresh session on ${planner.id} (${msg}). Accepting by default (failure-open).`,
    );
    return "accept";
  }

  const promptOnce = async (text: string): Promise<string> => {
    const res = await planner.client.session.prompt({
      path: { id: sessionId },
      body: {
        agent: "swarm-read",
        model: { providerID: "ollama", modelID: planner.model },
        parts: [{ type: "text", text }],
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
      if (texts.length) return texts.join("\n");
    }
    return any?.data?.text ?? "";
  };

  let responseText: string;
  try {
    responseText = await promptOnce(fullPrompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(
      `[critic] prompt on ${planner.id} (fresh session) failed (${msg}). Accepting by default (failure-open).`,
    );
    return "accept";
  }
  if (ctx.isStopping()) return "accept";

  let parsed = parseCriticResponse(responseText);
  if (!parsed.ok) {
    ctx.appendSystem(
      `[critic] response did not parse (${parsed.reason}). Issuing repair prompt on same fresh session.`,
    );
    let repairResponse: string;
    try {
      repairResponse = await promptOnce(
        `${CRITIC_SYSTEM_PROMPT}\n\n${buildCriticRepairPrompt(responseText, parsed.reason)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(
        `[critic] repair prompt failed (${msg}). Accepting by default (failure-open).`,
      );
      return "accept";
    }
    if (ctx.isStopping()) return "accept";
    parsed = parseCriticResponse(repairResponse);
    if (!parsed.ok) {
      ctx.appendSystem(
        `[critic] still invalid after repair (${parsed.reason}). Accepting by default (failure-open).`,
      );
      return "accept";
    }
  }

  if (parsed.critic.verdict === "reject") {
    ctx.board.markStale(
      todo.id,
      `critic rejected (${planner.id}): ${parsed.critic.rationale}`,
    );
    ctx.appendSystem(
      `[critic] ${planner.id} REJECTED ${proposingAgent.id}'s diff on "${truncate(todo.description)}": ${parsed.critic.rationale}`,
    );
    ctx.bumpRejected(proposingAgent.id);
    return "reject";
  }
  ctx.appendSystem(
    `[critic] ${planner.id} accepted ${proposingAgent.id}'s diff: ${parsed.critic.rationale}`,
  );
  return "accept";
}

async function runCriticEnsemble(
  planner: Agent,
  proposingAgent: Agent,
  todo: Todo,
  userPrompt: string,
  ctx: CriticContext,
): Promise<"accept" | "reject"> {
  const lanes: Array<{ name: string; system: string }> = [
    { name: SUBSTANCE_CRITIC_NAME, system: CRITIC_SYSTEM_PROMPT },
    { name: REGRESSION_CRITIC_NAME, system: REGRESSION_CRITIC_SYSTEM_PROMPT },
    { name: CONSISTENCY_CRITIC_NAME, system: CONSISTENCY_CRITIC_SYSTEM_PROMPT },
  ];
  const verdicts = await Promise.all(
    lanes.map((lane) =>
      runCriticLane(planner, todo, lane.name, lane.system, userPrompt, ctx),
    ),
  );
  type Lane = (typeof lanes)[number];
  const successful = verdicts
    .map((v, i) => ({ verdict: v, lane: lanes[i] as Lane }))
    .filter((x): x is { verdict: "accept" | "reject"; lane: Lane } => x.verdict !== "abstain");
  if (successful.length === 0) {
    ctx.appendSystem(
      `[critic-ensemble] all 3 critics failed to produce a verdict on ${proposingAgent.id}'s diff; accepting by default (failure-open).`,
    );
    return "accept";
  }
  const accepts = successful.filter((x) => x.verdict === "accept").length;
  const rejects = successful.length - accepts;
  let verdict: "accept" | "reject";
  if (accepts > rejects) verdict = "accept";
  else if (rejects > accepts) verdict = "reject";
  else {
    const substance = successful.find((x) => x.lane.name === SUBSTANCE_CRITIC_NAME);
    verdict = substance ? substance.verdict : "accept";
  }
  ctx.appendSystem(
    `[critic-ensemble] verdict on ${proposingAgent.id}'s diff: ${verdict.toUpperCase()} (${accepts} accept / ${rejects} reject / ${3 - successful.length} abstain).`,
  );
  if (verdict === "reject") {
    const rejectingLane =
      successful.find((x) => x.lane.name === SUBSTANCE_CRITIC_NAME && x.verdict === "reject") ??
      successful.find((x) => x.verdict === "reject")!;
    ctx.board.markStale(
      todo.id,
      `critic ensemble rejected (lead: ${rejectingLane.lane.name})`,
    );
    ctx.bumpRejected(proposingAgent.id);
  }
  return verdict;
}

async function runCriticLane(
  planner: Agent,
  todo: Todo,
  laneName: string,
  systemPrompt: string,
  userPrompt: string,
  ctx: CriticContext,
): Promise<"accept" | "reject" | "abstain"> {
  let sessionId: string;
  try {
    const created = await planner.client.session.create({
      body: { title: `critic-${laneName}-${todo.id}-${Date.now()}` },
    });
    const any = created as { data?: { id?: string; info?: { id?: string } }; id?: string };
    const sid = any?.data?.id ?? any?.data?.info?.id ?? any?.id;
    if (!sid) throw new Error("session.create returned no session id");
    sessionId = sid;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[critic-${laneName}] session.create failed (${msg}); abstaining.`);
    return "abstain";
  }
  const promptOnce = async (text: string): Promise<string> => {
    const res = await planner.client.session.prompt({
      path: { id: sessionId },
      body: {
        agent: "swarm-read",
        model: { providerID: "ollama", modelID: planner.model },
        parts: [{ type: "text", text }],
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
      if (texts.length) return texts.join("\n");
    }
    return any?.data?.text ?? "";
  };
  let response: string;
  try {
    response = await promptOnce(`${systemPrompt}\n\n${userPrompt}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[critic-${laneName}] prompt failed (${msg}); abstaining.`);
    return "abstain";
  }
  if (ctx.isStopping()) return "abstain";
  let parsed = parseCriticResponse(response);
  if (!parsed.ok) {
    try {
      response = await promptOnce(
        `${systemPrompt}\n\n${buildCriticRepairPrompt(response, parsed.reason)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(`[critic-${laneName}] repair failed (${msg}); abstaining.`);
      return "abstain";
    }
    if (ctx.isStopping()) return "abstain";
    parsed = parseCriticResponse(response);
    if (!parsed.ok) {
      ctx.appendSystem(`[critic-${laneName}] still invalid after repair; abstaining.`);
      return "abstain";
    }
  }
  ctx.appendSystem(
    `[critic-${laneName}] ${parsed.critic.verdict.toUpperCase()}: ${parsed.critic.rationale}`,
  );
  return parsed.critic.verdict;
}
