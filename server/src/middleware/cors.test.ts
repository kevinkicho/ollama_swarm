import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

async function request(port: number, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { method = "GET", headers: reqHeaders = {} } = options;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: reqHeaders }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => { body += c; });
      res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function getPort(server: http.Server): number {
  return (server.address() as net.AddressInfo).port;
}

describe("cors middleware", () => {
  it("sets Access-Control-Allow-Origin for simple GET", async () => {
    const express = (await import("express")).default;
    const { corsMiddleware } = await import("./cors.js");
    const app = express();
    app.use(corsMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    const port = getPort(server);
    try {
      const res = await request(port, "/test", { headers: { "Origin": "http://localhost:3000" } });
      assert.ok(res.headers["access-control-allow-origin"]);
    } finally {
      server.close();
    }
  });

  it("responds to OPTIONS preflight with 204", async () => {
    const express = (await import("express")).default;
    const { corsMiddleware } = await import("./cors.js");
    const app = express();
    app.use(corsMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    const port = getPort(server);
    try {
      const res = await request(port, "/test", { method: "OPTIONS", headers: { "Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST" } });
      assert.equal(res.status, 204);
      assert.ok(res.headers["access-control-allow-origin"]);
      assert.ok(res.headers["access-control-allow-methods"]);
    } finally {
      server.close();
    }
  });

  it("allows Content-Type and Authorization in requests", async () => {
    const express = (await import("express")).default;
    const { corsMiddleware } = await import("./cors.js");
    const app = express();
    app.use(corsMiddleware);
    app.post("/test", express.json(), (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    const port = getPort(server);
    try {
      const res = await request(port, "/test", {
        method: "OPTIONS",
        headers: {
          "Origin": "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type, Authorization",
        },
      });
      assert.equal(res.status, 204);
      const allowed = (res.headers["access-control-allow-headers"] ?? "").toLowerCase();
      assert.ok(allowed.includes("content-type"));
      assert.ok(allowed.includes("authorization"));
    } finally {
      server.close();
    }
  });

  it("sets max-age to 86400", async () => {
    const express = (await import("express")).default;
    const { corsMiddleware } = await import("./cors.js");
    const app = express();
    app.use(corsMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    const port = getPort(server);
    try {
      const res = await request(port, "/test", {
        method: "OPTIONS",
        headers: { "Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET" },
      });
      assert.equal(res.headers["access-control-max-age"], "86400");
    } finally {
      server.close();
    }
  });
});