/**
 * Host shell selection for the `run` / `bash` tools.
 * Windows: prefer PowerShell 7 (pwsh) when available, else cmd via ComSpec.
 * Not Administrator elevation — user-level host tools under the clone.
 */

import { spawnSync } from "node:child_process";

export type HostShellKind = "pwsh" | "cmd" | "sh";

export interface HostShell {
  kind: HostShellKind;
  /** How to spawn: file + args (shell:false) or command string (shell:true). */
  mode: "argv" | "shell";
  file?: string;
  /** Prefix args before the user command (argv mode only). */
  prefixArgs?: string[];
  label: string;
}

let cached: HostShell | null = null;
let cachePlatform: string | null = null;

/** Force re-resolve (tests). */
export function resetHostShellCache(): void {
  cached = null;
  cachePlatform = null;
}

function whichPwsh(): string | null {
  // Prefer PowerShell 7; fall back to Windows PowerShell.
  for (const name of ["pwsh", "pwsh.exe", "powershell", "powershell.exe"]) {
    try {
      const r = spawnSync(name, ["-NoProfile", "-Command", "echo ok"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_000,
      });
      if (r.status === 0) return name;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Resolve the host shell for this process.
 * Override with SWARM_HOST_SHELL=pwsh|cmd|sh.
 */
export function resolveHostShell(): HostShell {
  const plat = process.platform;
  if (cached && cachePlatform === plat) return cached;
  cachePlatform = plat;

  const force = (process.env.SWARM_HOST_SHELL ?? "").trim().toLowerCase();
  if (plat === "win32") {
    if (force === "cmd") {
      cached = {
        kind: "cmd",
        mode: "shell",
        label: "cmd (SWARM_HOST_SHELL=cmd)",
      };
      return cached;
    }
    if (force !== "cmd") {
      // default + explicit pwsh: try PowerShell first
      const pwsh = whichPwsh();
      if (pwsh && force !== "sh") {
        cached = {
          kind: "pwsh",
          mode: "argv",
          file: pwsh,
          prefixArgs: ["-NoProfile", "-NonInteractive", "-Command"],
          label: `PowerShell (${pwsh})`,
        };
        return cached;
      }
    }
    cached = {
      kind: "cmd",
      mode: "shell",
      label: "cmd (ComSpec)",
    };
    return cached;
  }

  // POSIX
  if (force === "pwsh") {
    const pwsh = whichPwsh();
    if (pwsh) {
      cached = {
        kind: "pwsh",
        mode: "argv",
        file: pwsh,
        prefixArgs: ["-NoProfile", "-NonInteractive", "-Command"],
        label: `PowerShell (${pwsh})`,
      };
      return cached;
    }
  }
  cached = {
    kind: "sh",
    mode: "shell",
    label: "sh (shell:true)",
  };
  return cached;
}
