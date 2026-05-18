import { execSync } from "node:child_process";
import type { Server } from "node:net";
import net from "node:net";

export interface HealthCheckResult {
  warnings: string[];
}

export async function startupHealthCheck(
  serverPort: number,
  runsDir: string,
): Promise<HealthCheckResult> {
  const warnings: string[] = [];

  // 1. Port conflict check. Try to briefly bind the port before the real
  //    server does. If something is already listening, we log a warning
  //    so the operator knows the real listen will fail.
  await new Promise<void>((resolve) => {
    const probe: Server = net.createServer();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        warnings.push(
          `Port ${serverPort} is already in use — server startup will fail. ` +
          "Stop the other process or change SERVER_PORT.",
        );
      }
      done();
    });
    probe.once("listening", () => {
      probe.close();
      done();
    });
    // 500 ms socket-level timeout — if the kernel holds the port
    // in TIME_WAIT, EADDRINUSE fires faster than the timeout anyway.
    setTimeout(done, 500);
    probe.listen(serverPort, "0.0.0.0");
  });

  // 2. Disk space check. For Linux/macOS only — on Windows this is
  //    best-effort. Warn if available space drops below 2 GB.
  try {
    const output = execSync("df -B 1 .", { encoding: "utf8", timeout: 3000 });
    const lines = output.trim().split("\n");
    if (lines.length >= 2) {
      const cols = lines[1].split(/\s+/);
      const available = parseInt(cols[3], 10);
      if (!isNaN(available)) {
        const gb = (available / 1_073_741_824).toFixed(1);
        if (available < 2_147_483_648) {
          warnings.push(
            `Disk space low: ${gb} GB available. Runs may fail if disk fills up.`,
          );
        } else {
          console.log(`  disk: ${gb} GB available`);
        }
      }
    }
  } catch {
    // df not available or timed out — non-critical, skip.
  }

  // 3. Runs directory size check — warn if an unusual number of
  //    leftover run directories exist (could indicate zombie cleanup
  //    isn't working).
  try {
    let entries: string[] = [];
    try {
      entries = require("node:fs").readdirSync(runsDir);
    } catch {
      // runs/ doesn't exist yet — no warning needed.
    }
    const runDirs = entries.filter((e) => /^\d{14}$/.test(e));
    if (runDirs.length > 50) {
      warnings.push(
        `Large number of leftover run directories (${runDirs.length}) ` +
        `in ${runsDir}. Consider running ` +
        `'rm -rf ${runsDir.replace(/'/g, "\\'")}/*' to free disk space.`,
      );
    }
  } catch {
    // Non-critical.
  }

  return { warnings };
}
