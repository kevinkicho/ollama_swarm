import fs from "node:fs";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

function resolveBackendPort(mode: string): number {
  const env = loadEnv(mode, process.cwd(), "");
  if (env.SERVER_PORT && env.SERVER_PORT.trim() !== "") {
    const n = Number(env.SERVER_PORT);
    if (Number.isInteger(n) && n > 0) return n;
  }
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, "..", ".server-port"), "utf8").trim();
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    // fall through
  }
  return 5174;
}

export default defineConfig(({ mode }) => {
  const backend = resolveBackendPort(mode);
  const target = `http://127.0.0.1:${backend}`;
  // Perf review 2026-04-24: opt-in bundle analyzer. Emits
  // `web/dist/stats.html` + `stats.json` alongside the built bundle
  // when `ANALYZE=1 npm run build` runs. Off by default so normal
  // builds stay fast and dist/ stays clean.
  const analyze = process.env.ANALYZE === "1" || process.env.ANALYZE === "true";
  const plugins = [react()];
  if (analyze) {
    plugins.push(
      visualizer({
        filename: "dist/stats.html",
        template: "treemap",
        gzipSize: true,
        brotliSize: true,
        open: false,
      }),
    );
  }
  return {
    plugins,
    define: {
      __BACKEND_PORT__: JSON.stringify(backend),
    },
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        "/api": { target, changeOrigin: true },
      },
      // WSL2 + /mnt/c — inotify doesn't see Windows-side file changes, so
      // chokidar must poll. Cheap on this small tree (a few dozen files);
      // pays off the first time you save a fix mid-session and want HMR
      // to actually fire instead of "did it not save?" debugging.
      watch: {
        usePolling: true,
        interval: 250,
      },
    },
  };
});
