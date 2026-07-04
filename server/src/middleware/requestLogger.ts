import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { createLogger } from "../services/logger.js";

declare global {
  namespace Express {
    interface Request {
      reqId?: string;
    }
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  req.reqId = randomUUID();
  res.setHeader("X-Request-Id", req.reqId);

  const log = createLogger({ reqId: req.reqId });

  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (res.statusCode >= 500) {
      log.error(`${req.method} ${req.path}`, { status: res.statusCode, ms });
    } else if (res.statusCode >= 400) {
      log.warn(`${req.method} ${req.path}`, { status: res.statusCode, ms });
    } else {
      log.info(`${req.method} ${req.path}`, { status: res.statusCode, ms });
    }
  });
  next();
}