#!/usr/bin/env node
/** Manual escape hatch: free backend, web, and Ollama proxy ports from a stuck dev session. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePorts } from "./lib/freePort.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const portFile = path.join(root, ".server-port");

function parsePort(raw) {
  if (!raw) return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

const serverPort =
  parsePort(process.env.SERVER_PORT) ??
  parsePort(fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8") : null) ??
  8243;
const webPort = parsePort(process.env.WEB_PORT) ?? 8244;
const proxyPort = parsePort(process.env.OLLAMA_PROXY_PORT) ?? 11533;

const ports = [serverPort, webPort];
if (proxyPort > 0) ports.push(proxyPort);

const results = await freePorts(ports, {
  log: (msg) => console.log(msg),
});

for (const r of results) {
  if (r.freed) {
    const detail = r.pidsKilled.length ? ` (PID ${r.pidsKilled.join(", ")})` : "";
    console.log(`freed :${r.port}${detail}`);
  } else {
    console.error(
      `:${r.port} still busy after cleanup` +
        (r.pidsKilled.length ? ` — killed PID(s) ${r.pidsKilled.join(", ")} but port did not release` : "") +
        ". Try closing other dev terminals or reboot.",
    );
    process.exitCode = 1;
  }
}