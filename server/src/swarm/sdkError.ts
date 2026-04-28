// Shared SDK / network error formatter. Walks `Error.cause` chains
// (up to 4 deep) and renders them as " <- "-separated segments so a
// transcript or log line carries the full failure trail without
// stack traces. Codes (err.code) are included inline when present.
//
// Identically duplicated across CouncilRunner, DebateJudgeRunner,
// MapReduceRunner, OrchestratorWorkerRunner, OrchestratorWorkerDeepRunner,
// RoundRobinRunner and BlackboardRunner before this consolidation.
// Now imported from one place; behavior unchanged.

export function describeSdkError(err: unknown): string {
  if (err instanceof Error) {
    const parts: string[] = [err.message];
    let cause: unknown = (err as { cause?: unknown }).cause;
    let depth = 0;
    while (cause && depth < 4) {
      if (cause instanceof Error) {
        const code = (cause as { code?: string }).code;
        parts.push(code ? `${cause.message} [${code}]` : cause.message);
        cause = (cause as { cause?: unknown }).cause;
      } else {
        parts.push(String(cause));
        cause = undefined;
      }
      depth++;
    }
    return parts.join(" <- ");
  }
  if (err && typeof err === "object") {
    const o = err as { name?: string; message?: string };
    const head = o.name ? `${o.name}: ` : "";
    if (o.message) return head + o.message;
    try {
      return head + JSON.stringify(o).slice(0, 500);
    } catch {
      return head + String(err);
    }
  }
  return String(err);
}
