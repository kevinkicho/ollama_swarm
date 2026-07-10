import fs from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";

/** Resolve req path under webDir; reject escape via .. or absolute segments. */
export function resolveStaticPath(webDir: string, reqPath: string): string | null {
  const root = path.resolve(webDir);
  // Strip query; decode carefully; block null bytes.
  const raw = (reqPath.split("?")[0] ?? "").replace(/\0/g, "");
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  const rel = decoded.replace(/^[/\\]+/, "");
  const candidate = path.resolve(root, rel);
  const relToRoot = path.relative(root, candidate);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    return null;
  }
  return candidate;
}

export function staticServing(webDir: string): (req: Request, res: Response, next: NextFunction) => void {
  const indexHtml = path.join(path.resolve(webDir), "index.html");

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return next();
    }
    if (req.path.startsWith("/api/") || req.path.startsWith("/ws")) {
      return next();
    }
    const filePath = resolveStaticPath(webDir, req.path);
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
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