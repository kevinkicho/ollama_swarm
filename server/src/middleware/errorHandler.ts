import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export interface ApiErrorBody {
  error: string;
  ok: false;
  details?: unknown;
}

export function formatZodError(err: ZodError): { error: string; details: unknown } {
  const fieldErrors = err.flatten().fieldErrors;
  const formErrors = err.flatten().formErrors;
  const parts: string[] = [];
  if (formErrors.length > 0) parts.push(formErrors.join("; "));
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (messages && messages.length > 0) parts.push(`${field}: ${messages.join(", ")}`);
  }
  return { error: parts.join(" | ") || "Validation failed", details: { fieldErrors, formErrors } };
}

export function globalErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  if (err instanceof ZodError) {
    const { error, details } = formatZodError(err);
    res.status(400).json({ error, ok: false, details });
    return;
  }

  const status = (err as { status?: number }).status ?? 500;
  const message = status >= 500 ? "Internal server error" : err.message;
  if (status >= 500) {
    console.error(`[server] ${status} error:`, err.stack ?? err.message);
  }
  res.status(status).json({ error: message, ok: false });
}

export function apiError(
  res: Response,
  status: number,
  message: string,
  details?: unknown,
): Response {
  return res.status(status).json({ error: message, ok: false, ...(details !== undefined ? { details } : {}) });
}

export function apiSuccess<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ data, ok: true });
}