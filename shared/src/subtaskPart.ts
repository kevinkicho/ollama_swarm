// Task #235 (2026-04-27 evening): typed builder for opencode v2's
// SubtaskPartInput. Parents that dispatch subtasks include one or
// more of these in their session.prompt parts array; opencode
// translates each into a TaskTool invocation that runs the subtask
// in an isolated child session linked to the parent via parentID.
//
// Result: each subtask's response comes back as inline text in the
// parent's response wrapped as `<task_result>...</task_result>` (per
// opencode v1.14.28 packages/opencode/src/tool/task.ts).
//
// The CALLING AGENT (the one running the parent prompt) needs the
// `task` permission allowed — see the swarm-orchestrator profile in
// RepoService.writeOpencodeConfig.
//
// Used by: planned migration of CouncilRunner, OrchestratorWorkerRunner,
// OrchestratorWorkerDeepRunner, MapReduceRunner. See
// docs/plans/subtask-migration-plan.md for the file-by-file blueprint.

export interface SubtaskPart {
  /** Discriminator. Matches opencode's SubtaskPartInput.type. */
  type: "subtask";
  /** Short (~3-5 word) human label opencode logs / surfaces in UI. */
  description: string;
  /** The actual prompt the subtask agent runs against. */
  prompt: string;
  /** Which agent profile the subtask runs as. Common: "swarm-read"
   *  for read-only inspection subtasks; "swarm" for pure-text
   *  no-tools subtasks. */
  agent: string;
  /** Optional model override; subtask defaults to the parent's model. */
  model?: { providerID: string; modelID: string };
}

/** Build a single SubtaskPartInput. Pass the result inside a
 *  session.prompt's parts array. opencode auto-dispatches it via
 *  TaskTool. */
export function subtaskPart(input: {
  description: string;
  prompt: string;
  agent: string;
  model?: { providerID: string; modelID: string };
}): SubtaskPart {
  return {
    type: "subtask",
    description: input.description.slice(0, 80),  // opencode caps the description display
    prompt: input.prompt,
    agent: input.agent,
    ...(input.model ? { model: input.model } : {}),
  };
}

// The result wrapper opencode produces for each subtask output.
// Format observed in opencode source: `task_id: <id>\n\n<task_result>\n<text>\n</task_result>`.
const TASK_RESULT_RE = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/g;

/** Parse a parent's response text and extract each subtask's
 *  unwrapped output in order. Returns an array of strings — one per
 *  `<task_result>` block found. Empty array means the model didn't
 *  invoke any subtasks (or opencode didn't surface them). */
export function extractSubtaskResults(parentResponseText: string): string[] {
  if (!parentResponseText || !parentResponseText.includes("<task_result>")) return [];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  TASK_RESULT_RE.lastIndex = 0;
  while ((m = TASK_RESULT_RE.exec(parentResponseText)) !== null) {
    out.push(m[1] ?? "");
  }
  return out;
}
