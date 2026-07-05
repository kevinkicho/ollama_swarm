# Initialization Sequence

High-level boot order for the full system (dev or production).

1. `npm run dev` (or equivalent) starts the Node server via `scripts/dev.mjs`.
2. Server loads config (requires `OPENCODE_SERVER_PASSWORD` for schema validation).
3. Ollama proxy (if enabled) starts on the configured port.
4. Express app + WebSocket server bind.
5. Static serving for built web frontend (or Vite dev server for live UI).
6. Brain overseer components initialize (analysis, proposals, etc.).
7. System is ready to accept `/api/swarm/start` and serve the UI at the web port.

Per-run initialization (when a swarm starts):
- Clone or reuse the target repo.
- Spawn agent records (in-process).
- Build initial system messages and seed.
- Enter the preset-specific runner loop (blackboard, council, etc.).

See `server/src/index.ts` and the relevant Runner for exact wiring.
