import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import express from "express";
import { staticServing } from "./staticServing.js";

function getPort(server: http.Server): number {
  return (server.address() as net.AddressInfo).port;
}

async function request(port: number, urlPath: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => { body += c; });
      res.on("end", () => {
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("staticServing middleware", () => {
  let tmpDir: string;
  let server: http.Server;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "static-test-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html>app</html>");
    fs.writeFileSync(path.join(tmpDir, "style.css"), "body{color:red}");
    fs.mkdirSync(path.join(tmpDir, "assets"));
    fs.writeFileSync(path.join(tmpDir, "assets", "app.js"), "// app");

    const app = express();
    app.use(staticServing(tmpDir));
    app.get("/api/health", (_req, res) => res.json({ ok: true }));
    server = app.listen(0) as http.Server;
  });

  after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves index.html for unknown paths (SPA fallback)", async () => {
    const res = await request(getPort(server), "/some/route");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("app"));
  });

  it("serves existing static files", async () => {
    const res = await request(getPort(server), "/style.css");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("color:red"));
  });

  it("serves nested static files", async () => {
    const res = await request(getPort(server), "/assets/app.js");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("app"));
  });

  it("does not intercept /api routes", async () => {
    const res = await request(getPort(server), "/api/health");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("ok"));
  });

  it("does not intercept /ws paths", async () => {
    const res = await request(getPort(server), "/ws");
    assert.equal(res.status, 404);
  });
});