import type { Request, Response, NextFunction } from "express";

export const API_VERSION = "1.0.0";

export function apiVersion(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-API-Version", API_VERSION);
  next();
}