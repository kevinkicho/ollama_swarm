import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const portFile = path.join(root, ".server-port");

// Fixed ports — pinned so bookmarks, scripts, and the Network tab don't need
// to chase a new port on every restart. Override with env vars if you need to.
//
// 2026-04-27: defaults moved 52243/52244 → 8243/8244. Windows reserves the
// 52199–52398 range for Hyper-V, so the previous defaults could fail with
// EACCES on most Windows hosts. 8243/8244 sit well outside any commonly
// reserved range. Verify your host's reserved ranges with
// `netsh int ipv4 show excludedportrange protocol=tcp` if EACCES recurs.
const DEFAULT_SERVER_PORT = 8243;
const DEFAULT_WEB_PORT = 8244;

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

function parsePort(raw) {
  if (!raw) return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

const port = parsePort(process.env.SERVER_PORT) ?? DEFAULT_SERVER_PORT;
const webPort = parsePort(process.env.WEB_PORT) ?? DEFAULT_WEB_PORT;
// Keep .server-port in sync so vite.config.ts + server/src/config.ts resolve
// the same port even when someone skips the env var.
fs.writeFileSync(portFile, String(port), "utf8");
// Propagate to children so server/src/config.ts sees the same value we picked.
process.env.SERVER_PORT = String(port);
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

// On Windows, `child.kill("SIGTERM")` only terminates the direct child —
// our server process — while grandchildren like opencode.exe workers keep
// running and holding their ports. `taskkill /T /F` walks the process tree
// and force-terminates everything. On POSIX we keep the signal path because
// Node's signal forwarding is reliable there.
function treeKill(child, signal) {
  if (!child || child.pid === undefined) return;
  if (child.killed || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      const k = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      k.on("error", () => {
        try { child.kill(); } catch {}
      });
    } catch {
      try { child.kill(); } catch {}
    }
    return;
  }
  try { child.kill(signal ?? "SIGTERM"); } catch {}
}

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
    if (shuttingDown) return;
    // Task #44: don't cascade-shutdown the other child when one dies.
    // Previously, if the server (tsx watch) crashed, we killed vite
    // too — which caused the browser's @vite/client to spam
    // ERR_CONNECTION_REFUSED for the whole restart window. Now the
    // surviving child keeps running so the UI stays responsive while
    // the user decides whether to restart the dead one manually.
    console.log(
      `[dev] ${name} exited (code=${code} signal=${signal}). Other children left running; press Ctrl-C to stop the rest or re-run \`npm run dev\` to restart.`,
    );
  });
  children.push({ name, child });
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    treeKill(child, "SIGTERM");
  }
  // hard-kill any leftovers after 4s (on Windows `taskkill /F` is already
  // the strongest kill; the second call re-issues it in case the first
  // taskkill couldn't find/reach the tree)
  setTimeout(() => {
    for (const { child } of children) {
      treeKill(child, "SIGKILL");
    }
    process.exit(0);
  }, 4000).unref();
}

process.on("SIGINT", () => {
  console.log("\n[dev] SIGINT — stopping children");
  shutdown();
});
process.on("SIGTERM", shutdown);

// 2026-04-27: --no-watch / NO_WATCH=1 disables tsx watch on the server.
// Use during long validation runs to dodge the WSL inotify SIGTERM-after-
// summary-write flake (see reference_wsl_sigterm_after_summary memory).
// Trade-off: code edits require manual restart of the dev server.
const noWatch = process.argv.includes("--no-watch") || process.env.NO_WATCH === "1";
const serverArgs = noWatch
  ? [tsxCli, "src/index.ts"]
  : [tsxCli, "watch", "src/index.ts"];
if (noWatch) console.log("[dev] server running WITHOUT tsx watch (--no-watch). Code edits won't auto-restart.");
launch("server", path.join(root, "server"), serverArgs, "36");
launch("web", path.join(root, "web"), [viteCli, "--port", String(webPort), "--strictPort", "--host"], "35");
