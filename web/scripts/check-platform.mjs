#!/usr/bin/env node
// Preinstall guard: WSL npm install swaps platform-specific esbuild binaries
// (Windows → Linux), breaking the Windows dev server. This script blocks
// install from WSL so the contributor runs npm install from a Windows terminal
// instead. CI runs in native Linux and needs esbuild-linux — skip there.

import fs from "node:fs";

const isWsl =
  !!process.env.WSL_DISTRO_NAME ||
  fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");

const isCI = process.env.CI === "true";
const skipCheck = process.env.SKIP_WSL_CHECK === "true";

if (isWsl && !isCI && !skipCheck) {
  console.error(
    "WSL detected — DO NOT `npm install` from WSL.\n" +
    "esbuild ships platform-specific binaries. Running npm install from WSL\n" +
    "swaps the Windows binary for a Linux one, silently breaking the Windows\n" +
    "dev server on next launch (vite fails with 'Exec format error').\n\n" +
    "Fix: run `npm install` from a Windows terminal (cmd, PowerShell, or\n" +
    "Windows Terminal) instead.\n",
  );
  process.exit(1);
}
