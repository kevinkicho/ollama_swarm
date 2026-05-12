import type { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const entries = new Map<string, RateLimitEntry>();

function cleanExpired(now: number): void {
  for (const [key, entry] of entries) {
    if (now > entry.resetTime) entries.delete(key);
  }
}

export function rateLimit(options: {
  windowMs: number;
  max: number;
  keyFn?: (req: Request) => string;
}): (req: Request, res: Response, next: NextFunction) => void {
  const { windowMs, max, keyFn = (req) => req.ip ?? "unknown" } = options;
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    cleanExpired(now);
    const key = keyFn(req);
    let entry = entries.get(key);
    if (!entry || now > entry.resetTime) {
      entry = { count: 0, resetTime: now + windowMs };
      entries.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(entry.resetTime / 1000)));
    if (entry.count > max) {
      res.status(429).json({ error: "Too many requests — rate limit exceeded", ok: false });
      return;
    }
    next();
  };
}

export const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
});

export const startLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
});