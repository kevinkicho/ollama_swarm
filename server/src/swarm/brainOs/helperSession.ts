/**
 * Ephemeral helper agent session for one Brain OS dispatch.
 */

import type { BrainDispatchRequest, HelperPrivilege } from "@ollama-swarm/shared/brainOs";
import type { TranscriptEntrySummary } from "../../types.js";
import { ToolDispatcher, type ProfileName } from "../../tools/ToolDispatcher.js";
import { noteHelperEnded, noteHelperStarted } from "./helperActivity.js";

export interface HelperSessionDeps {
  /** Low-level model chat: system+user → text. Uses run's provider stack. */
  chat: (opts: {
    model: string;
    system: string;
    user: string;
    tools?: string[];
    maxToolTurns?: number;
    clonePath: string;
    agentId: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  log?: (msg: string, summary?: TranscriptEntrySummary) => void;
}

function profileForPrivilege(p: HelperPrivilege): ProfileName {
  switch (p) {
    case "observer":
      return "swarm-read";
    case "repairer":
      return "swarm-write";
    case "runner":
    case "board_officer":
    case "arbiter":
      return "swarm-auto";
    default:
      return "swarm-read";
  }
}

function buildSystemPrompt(privileges: HelperPrivilege): string {
  return [
    "You are a Brain OS helper agent for ollama_swarm.",
    "You were recruited to RESOLVE a run-layer conflict — not to expand product scope.",
    "Use tools within your privileges. Prefer proof on disk (read/grep/git status) over speculation.",
    `Privilege tier: ${privileges}.`,
    "",
    "When finished, emit ONLY a JSON object (no markdown fence required):",
    "{",
    '  "status": "resolved" | "partial" | "blocked" | "needs_human",',
    '  "summary": "one paragraph",',
    '  "effects": [ /* board_complete|board_skip|board_reopen|append_system|request_apply|recommend_drain|recommend_stop|propose_hunks|board_post_todos|none */ ],',
    '  "children": [ /* optional: { "kind": "apply_miss"|"tool_block"|..., "hints": ["..."], "todoId": "..." } ] */',
    "}",
    "Do not invent long-term product criteria. Stay inside the clone path.",
    "Prefer git working-tree reality (git status / git diff / write|edit|run tools) over inventing search-replace hunks when files are already dirty.",
    "On Windows prefer the `run` tool (PowerShell/cmd host shell) for npm/node/git — not Unix-only bash binaries.",
  ].join("\n");
}

function buildUserPrompt(req: BrainDispatchRequest): string {
  const c = req.context;
  const parts = [
    `Conflict kind: ${req.kind}`,
    req.hints?.length ? `Hints: ${req.hints.join("; ")}` : "",
    c.todoId ? `Todo id: ${c.todoId}` : "",
    c.criterionIds?.length ? `Criteria: ${c.criterionIds.join(", ")}` : "",
    c.phase ? `Run phase: ${c.phase}` : "",
    c.host ? `Host: ${c.host}` : "",
    c.autoApprove != null ? `autoApprove: ${c.autoApprove}` : "",
    c.boardSnapshot
      ? `Board: pending=${c.boardSnapshot.pending} inProgress=${c.boardSnapshot.inProgress} pendingCommit=${c.boardSnapshot.pendingCommit} completed=${c.boardSnapshot.completed} skipped=${c.boardSnapshot.skipped}`
      : "",
    c.relevantFiles?.length ? `Relevant files:\n${c.relevantFiles.map((f) => `- ${f}`).join("\n")}` : "",
    c.lastErrors?.length ? `Last errors:\n${c.lastErrors.slice(0, 8).map((e) => `- ${e.slice(0, 400)}`).join("\n")}` : "",
    c.gitDiffExcerpt ? `Git diff excerpt:\n\`\`\`\n${c.gitDiffExcerpt.slice(0, 12_000)}\n\`\`\`` : "",
    c.transcriptExcerpt ? `Transcript excerpt:\n${c.transcriptExcerpt.slice(0, 8_000)}` : "",
    "",
    "Resolve the conflict. Emit the JSON result envelope when done.",
  ];
  return parts.filter(Boolean).join("\n");
}

/** Run one helper chat session; returns raw model text. */
export async function runHelperSession(
  req: BrainDispatchRequest,
  deps: HelperSessionDeps,
): Promise<string> {
  const model = req.helperModel ?? "deepseek-v4-flash:cloud";
  const agentId = `brain-os-helper-${req.depth}-${Date.now().toString(36)}`;
  const profile = profileForPrivilege(req.privileges);
  const dispatcher = new ToolDispatcher(profile, req.clonePath, undefined, agentId);
  await dispatcher.whenMcpReady();

  // Tools list from profile — ToolDispatcher enforces permissions.
  const { defaultToolsForProfile } = await import("../../tools/ToolDispatcher.js");
  const tools = [...defaultToolsForProfile(profile)];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.budget.maxWallMs);

  noteHelperStarted({
    helperId: agentId,
    runId: req.runId,
    kind: req.kind,
    privilege: req.privileges,
    depth: req.depth,
    model,
    startedAt: Date.now(),
    phase: req.context.phase,
  });
  deps.log?.(
    `[brain-os] helper ${agentId} recruited kind=${req.kind} privilege=${req.privileges} model=${model}`,
    {
      kind: "brain_os_dispatch",
      phase: "recruit",
      conflictKind: req.kind,
      helperId: agentId,
      privilege: req.privileges,
      depth: req.depth,
      model,
    },
  );

  try {
    return await deps.chat({
      model,
      system: buildSystemPrompt(req.privileges),
      user: buildUserPrompt(req),
      tools: tools as string[],
      maxToolTurns: req.budget.maxToolTurns,
      clonePath: req.clonePath,
      agentId,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    noteHelperEnded(req.runId, agentId);
    deps.log?.(`[brain-os] helper ${agentId} released`, {
      kind: "brain_os_dispatch",
      phase: "release",
      conflictKind: req.kind,
      helperId: agentId,
      privilege: req.privileges,
      depth: req.depth,
      model,
    });
    void dispatcher;
  }
}
