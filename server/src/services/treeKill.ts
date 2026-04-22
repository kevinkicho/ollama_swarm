import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// Fire-and-forget process-tree kill. On Windows `child.kill()` (or SIGTERM)
// only terminates the immediate child — for opencode agents that's the
// cmd.exe shell wrapper spawn-with-`shell:true` creates, leaving the real
// opencode.exe grandchild orphaned and still holding its port. `taskkill /T`
// walks the tree and `/F` force-terminates. On POSIX we fall back to the
// signal path, where Node's own signal forwarding is reliable.
export function treeKill(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined) return;
  if (child.killed || child.exitCode !== null) return;

  if (process.platform === "win32") {
    try {
      const k = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      k.on("error", () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}
