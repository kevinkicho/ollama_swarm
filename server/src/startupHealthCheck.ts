import { execSync } from "node:child_process";
import type { Server } from "node:net";
import net from "node:net";
import { readdirSync, statSync } from "node:fs";

export interface HealthCheckResult {
  warnings: string[];
}

export async function startupHealthCheck(
  serverPort: number,
  logsDir: string,
): Promise<HealthCheckResult> {
  const warnings: string[] = [];

  // 1. Port conflict check.
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
    setTimeout(done, 500);
    probe.listen(serverPort, "0.0.0.0");
  });

  // 2. Disk space check (cross-platform).
  try {
    let available: number | null = null;
    if (process.platform === "win32") {
      // Windows: use wmic (widely available) or fall back to PowerShell.
      try {
        const out = execSync(
          'wmic logicaldisk get size,freespace,caption /format:csv',
          { encoding: "utf8", timeout: 3000 },
        );
        // CSV has header + rows; pick the first non-empty drive's freespace (usually C:)
        const lines = out.trim().split(/\r?\n/).filter(Boolean);
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(",");
          if (parts.length >= 4) {
            const free = parseInt(parts[parts.length - 2], 10); // freespace column
            if (!isNaN(free) && free > 0) {
              available = free;
              break;
            }
          }
        }
      } catch {
        // Try PowerShell as fallback
        const ps = execSync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk | Where-Object {$_.DriveType -eq 3} | Select-Object -First 1 -ExpandProperty FreeSpace"',
          { encoding: "utf8", timeout: 3000 },
        );
        const val = parseInt(ps.trim(), 10);
        if (!isNaN(val)) available = val;
      }
    } else {
      const output = execSync("df -B 1 .", { encoding: "utf8", timeout: 3000 });
      const lines = output.trim().split("\n");
      if (lines.length >= 2) {
        const cols = lines[1].split(/\s+/);
        const val = parseInt(cols[3], 10);
        if (!isNaN(val)) available = val;
      }
    }

    if (available !== null) {
      const gb = (available / 1_073_741_824).toFixed(1);
      if (available < 2_147_483_648) {
        warnings.push(
          `Disk space low: ${gb} GB available. Runs may fail if disk fills up.`,
        );
      } else {
        console.log(`  disk: ${gb} GB available`);
      }
    }
  } catch {
    // Disk check not available or failed — non-critical, skip.
  }

  // 3. Logs directory size check — warn if too many run directories.
  try {
    let logEntries: string[] = [];
    try {
      logEntries = readdirSync(logsDir);
    } catch {
      // logs/ doesn't exist yet — no warning needed.
    }
    const runDirs = logEntries.filter((e) => {
      try {
        return statSync(`${logsDir}/${e}`).isDirectory();
      } catch {
        return false;
      }
    });
    if (runDirs.length > 50) {
      warnings.push(
        `Large number of run directories (${runDirs.length}) ` +
        `in ${logsDir}. Consider cleaning up old runs.`,
      );
    }
  } catch {
    // Non-critical.
  }

  return { warnings };
}
