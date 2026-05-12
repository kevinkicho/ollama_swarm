import fs from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";

export function staticServing(webDir: string): (req: Request, res: Response, next: NextFunction) => void {
  const indexHtml = path.join(webDir, "index.html");

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return next();
    }
    if (req.path.startsWith("/api/") || req.path.startsWith("/ws")) {
      return next();
    }
    let filePath = path.join(webDir, req.path);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.sendFile(filePath);
      return;
    }
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
      return;
    }
    next();
  };
}