import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

/**
 * Optional API token gate for /api/* routes.
 * When SWARM_API_TOKEN is unset, all requests pass (local trusted operator).
 * When set, require Authorization: Bearer <token> or X-Swarm-Token: <token>.
 *
 * Paths that remain open even when a token is configured (so the UI can
 * discover that the server is up before auth is wired on every client):
 *   GET /api/health, GET /api/version (if present)
 */
const OPEN_PATHS = new Set(["/api/health", "/api/version"]);

export function extractSwarmToken(req: Request): string | undefined {
  const header = req.headers["x-swarm-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]?.trim()) return header[0].trim();

  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

export function apiAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = config.SWARM_API_TOKEN;
  if (!expected) {
    next();
    return;
  }
  const pathOnly = (req.path || req.url || "").split("?")[0] ?? "";
  // Mounted under app: req.path is relative to mount when used as app.use("/api", …)
  // or absolute when applied as app.use(apiAuthMiddleware) before routes.
  const fullPath = pathOnly.startsWith("/api")
    ? pathOnly
    : pathOnly.startsWith("/")
      ? `/api${pathOnly === "/" ? "" : pathOnly}`
      : `/api/${pathOnly}`;
  const candidates = new Set([pathOnly, fullPath, req.originalUrl?.split("?")[0] ?? ""]);
  for (const p of candidates) {
    if (OPEN_PATHS.has(p)) {
      next();
      return;
    }
  }
  // Also allow exact health under /api when middleware is mounted at root
  // and Express gives path as /health on a /api router — handled by open list above.

  const got = extractSwarmToken(req);
  if (!got || got !== expected) {
    res.status(401).json({
      ok: false,
      error: "Unauthorized — set Authorization: Bearer <SWARM_API_TOKEN> or X-Swarm-Token",
    });
    return;
  }
  next();
}

/** True when the process is bound beyond loopback without a token (warn at boot). */
export function isInsecureLanExposure(): boolean {
  const host = config.SERVER_HOST;
  const loopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]";
  return !loopback && !config.SWARM_API_TOKEN;
}
