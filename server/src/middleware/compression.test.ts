import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";

async function request(port: number, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const { method = "GET", headers: reqHeaders = {} } = options;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: reqHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => { chunks.push(c); });
      res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function getPort(server: http.Server): number {
  return (server.address() as net.AddressInfo).port;
}

function gunzip(buf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buf, (err, result) => {
      if (err) reject(err);
      else resolve(result.toString("utf8"));
    });
  });
}

describe("compression middleware", () => {
  it("compresses responses above threshold with gzip", async () => {
    const express = (await import("express")).default;
    const { compressionMiddleware } = await import("./compression.js");
    const app = express();
    app.use(compressionMiddleware);
    app.get("/test", (_req, res) => {
      res.json({ data: "x".repeat(2048) });
    });
    const server = app.listen(0);
    const port = getPort(server);
    try {
      const res = await request(port, "/test", { headers: { "Accept-Encoding": "gzip" } });
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-encoding"], "gzip");
      const body = await gunzip(res.body);
      assert.ok(body.includes("xxxx"));
    } finally {
      server.close();
    }
  });

  it("does not compress responses below threshold", async () => {
    const express = (await import("express")).default;
    const { compressionMiddleware } = await import("./compression.js");
    const app = express();
    app.use(compressionMiddleware);
    app.get("/test", (_req, res) => {
      res.json({ data: "hi" });
    });
    const server = app.listen(0);
    const port = getPort(server);
    try {
      const res = await request(port, "/test", { headers: { "Accept-Encoding": "gzip" } });
      assert.equal(res.status, 200);
      assert.notEqual(res.headers["content-encoding"], "gzip");
    } finally {
      server.close();
    }
  });

  it("skips compression when x-no-compression header is set", async () => {
    const express = (await import("express")).default;
    const { compressionMiddleware } = await import("./compression.js");
    const app = express();
    app.use(compressionMiddleware);
    app.get("/test", (_req, res) => {
      res.json({ data: "x".repeat(2048) });
    });
    const server = app.listen(0);
    const port = getPort(server);
    try {
      const res = await request(port, "/test", { headers: { "Accept-Encoding": "gzip", "X-No-Compression": "1" } });
      assert.equal(res.status, 200);
      assert.notEqual(res.headers["content-encoding"], "gzip");
    } finally {
      server.close();
    }
  });
});