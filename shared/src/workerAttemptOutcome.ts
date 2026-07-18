/**
 * Structured worker attempt outcome — one line of truth for operators.
 * No prompts: pure serialization of recovery stages (anti-scare-log).
 */

export type WorkerAttemptStage =
  | "primary"
  | "apply_det"
  | "apply_llm_repair"
  | "json_repair"
  | "failover"
  | "settled";

export type WorkerAttemptTerminal =
  | "completed"
  | "skipped"
  | "failed"
  | "retry";

export interface WorkerAttemptOutcome {
  todoId: string;
  agentId: string;
  stage: WorkerAttemptStage;
  terminal: WorkerAttemptTerminal;
  /** Short machine bucket: apply_miss | json_parse | no_hunks | … */
  bucket?: string;
  file?: string;
  missKind?: string;
  detTried?: boolean;
  detOk?: boolean;
  llmRepair?: boolean;
  skipCode?: string;
  detail?: string;
}

/** Compact single-line system log (replaces multi-line scare sequences). */
export function formatWorkerAttemptOutcomeLine(o: WorkerAttemptOutcome): string {
  const parts = [
    `[worker-outcome]`,
    o.agentId,
    o.todoId.slice(0, 8),
    o.stage,
    o.terminal,
  ];
  if (o.bucket) parts.push(`bucket=${o.bucket}`);
  if (o.file) parts.push(`file=${o.file}`);
  if (o.missKind) parts.push(`miss=${o.missKind}`);
  if (o.detTried) parts.push(o.detOk ? "det=ok" : "det=miss");
  if (o.llmRepair) parts.push("llmRepair=1");
  if (o.skipCode) parts.push(`skip=${o.skipCode}`);
  if (o.detail) parts.push(o.detail.slice(0, 120).replace(/\s+/g, " "));
  return parts.join(" ");
}
