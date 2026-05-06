import { classifyError, type ClassifiedError, type ErrorCategory } from "../errorTaxonomy.js";

export interface ErrorRecorderContext {
  errorTracker: ClassifiedError[];
  maxTrackedErrors: number;
}

export function recordError(
  ctx: ErrorRecorderContext,
  err: unknown,
  opts: { causeHint?: ErrorCategory; statusCode?: number } = {},
): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const classified = classifyError({
    message,
    statusCode: opts.statusCode,
    causeHint: opts.causeHint,
  });
  ctx.errorTracker.push(classified);
  if (ctx.errorTracker.length > ctx.maxTrackedErrors) {
    ctx.errorTracker.shift();
  }
  return classified;
}