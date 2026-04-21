import fs from "node:fs";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

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
  return {
    plugins: [react()],
    define: {
      __BACKEND_PORT__: JSON.stringify(backend),
    },
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        "/api": { target, changeOrigin: true },
      },
    },
  };
});
