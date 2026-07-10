import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  listenerPidsForPort,
  freePortSync,
  freePort,
  isPortBindable,
} from "./freePort.mjs";

function listenEphemeral() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr !== "object") {
        s.close();
        reject(new Error("no port"));
        return;
      }
      resolve({ server: s, port: addr.port });
    });
    s.on("error", reject);
  });
}

describe("freePort", () => {
  it("listenerPidsForPort finds our LISTENING socket", async () => {
    const { server, port } = await listenEphemeral();
    try {
      const pids = listenerPidsForPort(port);
      assert.ok(pids.includes(process.pid), `expected pid ${process.pid} in ${pids.join(",")}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  async function spawnPortHolder() {
    const { spawn } = await import("node:child_process");
    // Bind 0.0.0.0 so isPortBindable's default probe conflicts (Windows can allow
    // 0.0.0.0 while 127.0.0.1 is held, which made the old test flaky).
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `require("net").createServer().listen(0,"0.0.0.0",function(){process.stdout.write(String(this.address().port));});setInterval(()=>{}, 1e6);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    const port = await new Promise((resolve, reject) => {
      let buf = "";
      holder.stdout.on("data", (d) => {
        buf += d.toString();
        const n = Number.parseInt(buf.trim(), 10);
        if (Number.isInteger(n) && n > 0) resolve(n);
      });
      holder.on("error", reject);
      setTimeout(() => reject(new Error("holder timeout")), 3000);
    });
    // Wait until bind probe fails (listener fully established).
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (!(await isPortBindable(port))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return { holder, port };
  }

  it("freePortSync kills foreign listener and frees port", async () => {
    const { holder, port } = await spawnPortHolder();
    try {
      assert.equal(await isPortBindable(port), false);
      const result = freePortSync(port, { retries: 6, delayMs: 100 });
      assert.equal(result.freed, true, `still busy pids=${result.pidsKilled.join(",")}`);
      assert.ok(result.pidsKilled.length >= 1);
      assert.equal(await isPortBindable(port), true);
    } finally {
      try {
        holder.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  });

  it("freePort async frees a held port", async () => {
    const { holder, port } = await spawnPortHolder();
    try {
      const result = await freePort(port, { retries: 6, delayMs: 100 });
      assert.equal(result.freed, true);
    } finally {
      try {
        holder.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  });
});
