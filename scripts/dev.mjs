import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const portFile = path.join(root, ".server-port");

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") srv.close(() => resolve(addr.port));
      else {
        srv.close();
        reject(new Error("failed to read ephemeral port"));
      }
    });
  });
}

const port = await pickFreePort();
const webPort = await pickFreePort();
fs.writeFileSync(portFile, String(port), "utf8");
console.log(`[dev] backend :${port}  ·  web :${webPort}  (wrote .server-port)`);

const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");

for (const [label, p] of [["tsx", tsxCli], ["vite", viteCli]]) {
  if (!fs.existsSync(p)) {
    console.error(`[dev] cannot find ${label} at ${p}. Run \`npm install\` first.`);
    process.exit(1);
  }
}

const children = [];
let shuttingDown = false;

function prefix(tag, color) {
  const esc = `\x1b[${color}m[${tag}]\x1b[0m `;
  return (buf) => {
    const text = buf.toString();
    const lines = text.split(/\r?\n/);
    const trailingNewline = text.endsWith("\n");
    const nonEmpty = lines.filter((_, i) => i < lines.length - 1 || lines[i] !== "");
    return nonEmpty.map((l) => esc + l).join("\n") + (trailingNewline ? "\n" : "");
  };
}

function launch(name, cwd, args, color) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    windowsHide: true,
  });
  const tagOut = prefix(name, color);
  child.stdout.on("data", (d) => process.stdout.write(tagOut(d)));
  child.stderr.on("data", (d) => process.stderr.write(tagOut(d)));
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.log(`[dev] ${name} exited (code=${code} signal=${signal}) — shutting down`);
      shutdown();
    }
  });
  children.push({ name, child });
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
  // hard-kill any leftovers after 4s
  setTimeout(() => {
    for (const { child } of children) {
      if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
    }
    process.exit(0);
  }, 4000).unref();
}

process.on("SIGINT", () => {
  console.log("\n[dev] SIGINT — stopping children");
  shutdown();
});
process.on("SIGTERM", shutdown);

launch("server", path.join(root, "server"), [tsxCli, "watch", "src/index.ts"], "36");
launch("web", path.join(root, "web"), [viteCli, "--port", String(webPort), "--strictPort"], "35");
