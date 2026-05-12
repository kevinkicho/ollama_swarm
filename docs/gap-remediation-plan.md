# Gap Remediation Plan

> Comprehensive implementation plan to abridge all gaps identified in the 2026-05-08 gap analysis.
> Each item has: priority, scope estimate, dependencies, step-by-step plan, and acceptance criteria.

---

## P0 — Critical ( shipped within 1 sprint )

### P0-1. Global Express error handler

**Severity:** MEDIUM → HIGH (unhandled errors crash with HTML 500)  
**Scope:** 1 file, ~40 LOC  
**Dependencies:** None

**Steps:**
1. Create `server/src/middleware/errorHandler.ts`:
  ```ts
   import type { Request, Response, NextFunction } from "express";
   export function globalErrorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
     const status = (err as any).status ?? 500;
     const message = err.message ?? "Internal server error";
     res.status(status).json({ error: message, ok: false });
   }
   ```
2. Add Zod error formatting helper:
   ```ts
   export function formatZodError(err: ZodError): { error: string; details: unknown } { ... }
   ```
3. In `server/src/index.ts`, mount as last middleware: `app.use(globalErrorHandler)`
4. Refactor existing per-route try/catch blocks to `throw` instead of `catch { res.status(500).json(...) }` — let the global handler do its job. Do this incrementally (not all routes at once).

**Acceptance:** Unhandled route errors return `{"error":"...","ok":false}` with correct HTTP status. No more HTML 500 pages.

---

### P0-2. Fix uncaughtException handler

**Severity:** HIGH  
**Scope:** 1 file (`index.ts`), ~10 LOC change  
**Dependencies:** None

**Steps:**
1. Change `process.on('uncaughtException', ...)` in `server/src/index.ts`:
   ```ts
   process.on('uncaughtException', (err) => {
     console.error('[FATAL] Uncaught exception — exiting:', err);
     try { eventLogger?.close(); } catch {}
     process.exit(1);
   });
   ```
2. Keep `unhandledRejection` handler as-is (log + broadcast is correct for rejected promises).

**Acceptance:** Process exits with code 1 on uncaught exception. No silent continuation after corrupt state.

---

### P0-3. Add rate limiting on write endpoints

**Severity:** MEDIUM  
**Scope:** 1 new dependency + 1 middleware file + route integration  
**Dependencies:** `express-rate-limit` (add to server/package.json)

**Steps:**
1. `npm install express-rate-limit` (from Windows, not WSL)
2. Create `server/src/middleware/rateLimiter.ts`:
   ```ts
   import rateLimit from "express-rate-limit";
   export const writeLimiter = rateLimit({
     windowMs: 60_000,
     max: 30,
     message: { error: "Too many requests — rate limit exceeded", ok: false },
     standardHeaders: true,
     legacyHeaders: false,
   });
   export const startLimiter = rateLimit({
     windowMs: 60_000,
     max: 5,
     message: { error: "Too many swarm starts — rate limit exceeded", ok: false },
   });
   ```
3. In `index.ts`, mount: `app.use("/api/swarm/start", startLimiter)` and `app.use("/api/swarm", writeLimiter)` for POST routes only.
4. Skip rate limiting on GET endpoints (read-heavy, low risk).

**Acceptance:** `/start` limited to 5/min; other POST endpoints limited to 30/min. 429 responses are well-formed JSON.

---

### P0-4. Add Zod validation to unvalidated routes

**Severity:** MEDIUM  
**Scope:** 1 new file + route modifications  
**Dependencies:** None (Zod already a dependency)

**Steps:**
1. Create `server/src/routes/schemas.ts` with Zod schemas for:
   - `MemoryStorePostBody`: `{ key: z.string().max(200), value: z.string().max(10000), clonePath: z.string().max(500), tags: z.array(z.string()).optional() }`
   - `MemoryStoreDeleteParams`: `{ key: z.string().max(200) }`
   - `PreflightQuery`: `{ repoUrl: z.string().url().optional(), parentPath: z.string().max(500).optional(), preset: z.string().optional() }`
   - `MemoryQuery`: `{ clonePath: z.string().max(500).optional(), includeOtherParents: z.coerce.boolean().optional() }`
   - `RunSummaryQuery`: `{ clonePath: z.string().max(500).optional(), runId: z.string().optional() }`
   - `OutcomeStatsQuery`: `{ clonePath: z.string().max(500).optional() }`
   - `OutcomeRecommendQuery`: `{ directive: z.string().max(4000).optional(), clonePath: z.string().max(500).optional() }`
   - `CheckpointsParams`: `{ runId: z.string().max(100) }`
   - `TimelineParams`: `{ runId: z.string().max(100) }`
   - `V2EventLogRunParams`: `{ runId: z.string().max(100) }`
   - `SayBodyPerRun`: `{ text: z.string().min(1).max(10000), intent: z.enum(["instruct","question","feedback"]).optional(), targetAgent: z.string().optional() }`
2. Add a `validate` helper:
   ```ts
   export function validate<T>(schema: ZodSchema<T>, source: "body" | "query" | "params") {
     return (req: Request, res: Response, next: NextFunction) => {
       const result = schema.safeParse(req[source]);
       if (!result.success) return res.status(400).json({ error: result.error.flatten(), ok: false });
       req[source] = result.data;
       next();
     };
   }
   ```
3. Apply validators to routes in `swarm.ts` and `v2.ts`. Replace ad-hoc `typeof` checks with schema-validated data.
4. Fix `/api/models` to return 500 on provider errors, not 200 with `{ error }`.

**Acceptance:** All routes with user input have Zod validation. No `typeof` checks remain in route handlers. `/api/models` returns correct HTTP status codes.

---

## P1 — High ( shipped within 2 sprints )

### P1-1. Add logging to 128 empty catch blocks

**Severity:** MEDIUM  
**Scope:** ~20 files, ~128 catch blocks  
**Dependencies:** None

**Plan (prioritized by risk):**

**Phase 1 — Runner catch blocks (highest impact, ~50 blocks):**
1. Create a shared `logCatch.ts` helper:
   ```ts
   export function logCatch(ctx: { appendSystem: (msg: string) => void }, label: string, err: unknown): void {
     const msg = err instanceof Error ? err.message : String(err);
     ctx.appendSystem(`⚠ ${label} failed (non-fatal): ${msg}`);
   }
   ```
2. In `workerRunner.ts` (8 catches): Replace each `catch {}` or `catch { /* skip */ }` with `logCatch(ctx, "workerApplyHunks", err)` or equivalent label.
3. In `lifecycleRunner.ts` (6 catches): Same pattern, labels like "plannerSpawn", "workerSpawn", "auditorSpawn".
4. In `replanManager.ts` (5 catches): Labels like "replanRead", "replanSkip".
5. In `RoundRobinRunner.ts` (6 catches), `StigmergyRunner.ts` (5), `MapReduceRunner.ts` (4), `DebateJudgeRunner.ts` (4): Systematic pass.
6. In all prompt builders (14 catches across `auditor.ts`, `critic.ts`, etc.): These are `catch { /* file read failed */ }` inside seed builders. Add `appendSystem` with filename context.

**Phase 2 — Service/utility catch blocks (~30 blocks):**
7. In `swarm.ts` routes (7 catches): Add structured error logging to each.
8. In `Orchestrator.ts` (3 catches): Add `log.error` calls.
9. In `v2Adapters.ts` (3 catches): Add contextual logging.
10. In `memoryStore.ts` (3 catches): Add `appendSystem` logging.

**Phase 3 — Web catch blocks (~5 blocks):**
11. In `SwarmView.tsx` (3 catches): Add `console.error` (no appendSystem in web).
12. In `RunHistory.tsx` (1 catch): Add `console.error`.
13. In component hooks (2 catches): Add `console.error`.

**Rule of thumb:** Every `catch` block must contain at least one of:
- `appendSystem(...)` (runner context)
- `console.error(...)` (web/utility)
- `logDiag?.(...)` (prompt diag channel)
- A comment explaining why it's intentionally silent with a specific reason

**Acceptance:** `grep -r "catch" server/src/ | grep -v ".test.ts" | grep -v "// "` returns zero empty catches. All catches either log, propagate, or have an `// intentional: <reason>` comment.

---

### P1-2. Type `contextBuilders.ts` — eliminate 14 `any` types

**Severity:** MEDIUM  
**Scope:** 1 file + shared type definitions  
**Dependencies:** None

**Steps:**
1. Create `server/src/swarm/blackboard/runnerContextTypes.ts` with proper interfaces:
   ```ts
   export interface SpawnOptions { cwd: string; index: number; model: string; }
   export interface CloneOptions { /* ... */ }
   export interface ObserverEvent { type: string; ts: number; [key: string]: unknown; }
   export interface FindingsEntry { agentId: string; text: string; createdAt: number; }
   export interface StatusMeta { retryAttempt?: number; retryMax?: number; retryReason?: string; }
   ```
2. Replace all `any` types in `contextBuilders.ts` with the proper interfaces.
3. Chase callers: update the 5 `buildPlannerContext` / `buildContractContext` / `buildAuditorContext` / `buildWorkerContext` / `buildReplanContext` functions to ensure the types flow through correctly.
4. Run `tsc --noEmit` to verify no type errors from the change.

**Acceptance:** Zero `any` in `contextBuilders.ts`. `tsc` passes. All 2337 tests pass.

---

### P1-3. Extract `emitOutcome` shared type

**Severity:** LOW-MEDIUM  
**Scope:** ~8 runner files + 1 new shared type  
**Dependencies:** None

**Steps:**
1. Create `server/src/swarm/outcomeTypes.ts`:
   ```ts
   export interface OutcomeScoredEvent {
     type: "outcome_scored";
     runId: string;
     preset: string;
     directive: string;
     scores: Record<string, number>;
     overall: number;
     model: string;
     wallClockMs: number;
     ts: number;
   }
   export type OutcomeEmitter = (outcome: OutcomeScoredEvent) => void;
   ```
2. Replace all `emitOutcome: (outcome: any) => void` in 8 runner files with `emitOutcome: OutcomeEmitter`.
3. Update `DiscussionRunnerBase.ts` to use the type.

**Acceptance:** Zero `outcome: any` in runner files. All tests pass.

---

### P1-4. Extract hardcoded localhost URLs

**Severity:** LOW  
**Scope:** 3 files, ~5 LOC changes  
**Dependencies:** None

**Steps:**
1. In `server/src/config.ts`, add:
   ```ts
   OLLAMA_DIRECT_FALLBACK_URL: z.string().default("http://127.0.0.1:11533"),
   OLLAMA_TAGS_FALLBACK_URL: z.string().default("http://127.0.0.1:11434"),
   ```
2. In `server/src/swarm/blackboard/promptRunner.ts`, replace both hardcoded URLs with `config.OLLAMA_DIRECT_FALLBACK_URL` and `config.OLLAMA_TAGS_FALLBACK_URL`.
3. In `server/src/swarm/blackboard/failoverDiscovery.ts`, replace the hardcoded URL with `config.OLLAMA_TAGS_FALLBACK_URL`.
4. In `server/src/swarm/blackboard/promptWithFailover.ts`, replace `5_000` backoff constant with a named `UNKNOWN_ERROR_RETRY_BACKOFF_MS = 5_000`.

**Acceptance:** `grep -r "127.0.0.1:11" server/src/ | grep -v config.ts | grep -v .test.ts` returns 0 results.

---

### P1-5. Add WS heartbeat + maxPayload

**Severity:** LOW-MEDIUM  
**Scope:** 1 file (`server/src/ws/broadcast.ts`) + `index.ts`  
**Dependencies:** None

**Steps:**
1. In `broadcast.ts` `Broadcaster.attach()`, configure `WebSocketServer`:
   ```ts
   const wss = new WebSocketServer({ 
     noServer: true,
     maxPayload: 1024 * 1024, // 1MB
   });
   ```
2. In `Broadcaster.attach()`, start a heartbeat interval:
   ```ts
   const heartbeat = setInterval(() => {
     for (const client of this.clients.values()) {
       if (!client.isAlive) { client.ws.terminate(); this.removeClient(client.id); continue; }
       client.isAlive = false;
       client.ws.ping();
     }
   }, 30_000);
   heartbeat.unref?.();
   wss.on("close", () => clearInterval(heartbeat));
   ```
3. On each client connect, set `client.isAlive = true` and listen for `"pong"` to reset it.
4. Add `"close"` cleanup to clear the interval on WSS shutdown.

**Acceptance:** Clients that don't respond to ping within 30s are disconnected. Messages > 1MB are rejected. No silent zombie connections.

---

## P2 — Medium ( shipped within 3 sprints )

### P2-1. Unit tests for `applyEvent.ts`

**Severity:** HIGH (critical reducer logic, 0 coverage)  
**Scope:** 1 new test file  
**Dependencies:** None

**Steps:**
1. Create `web/src/state/applyEvent.test.ts`
2. Test cases:
   - Each `SwarmEvent` variant applies correctly (start with the 24 variants in `wsProtocol.ts`)
   - `applyEvent` handles partial updates (e.g., `agent_state` with only `status` changed)
   - `applyEvent` handles `transcript_append` adding entries
   - `applyEvent` handles `run_summary` replacing the summary
   - `applyEvent` ignores unknown event types
   - `applyEvent` handles `brain-fallback`, `conformance_sample`, `drift_sample` correctly
3. Use the Zod schemas from `shared/src/wsProtocol.ts` to generate test fixtures.
4. Target: 20+ test cases covering all major event type categories.

**Acceptance:** `applyEvent.test.ts` passes. Coverage of the event reducer's core logic.

---

### P2-2. Unit tests for `SwarmRunner.ts` + `DiscussionRunnerBase.ts`

**Severity:** HIGH  
**Scope:** 2 new test files  
**Dependencies:** None

**Steps:**
1. Create `server/src/swarm/SwarmRunner.test.ts`:
   - Test `start()` with valid config → sets phase to "running"
   - Test `start()` with invalid config → throws or returns error
   - Test `stop()` → sets lifecycle state, broadcasts stopped
   - Test `drain()` → sets lifecycle state, broadcasts draining
   - Test concurrent run cap enforcement
   - Test per-run WS filtering
2. Create `server/src/swarm/DiscussionRunnerBase.test.ts`:
   - Test `stats()` aggregation
   - Test `writeSummary()` output shape
   - Test `multiWriterState` initialization when `writeMode="multi"`
   - Test discussion loop termination conditions
   - Test transcript accumulation
3. Use test scaffolding from `server/src/swarm/testScaffolding.test.ts` for mock agents/context.

**Acceptance:** 15+ test cases per file. Both files pass.

---

### P2-3. Unit tests for `BlackboardRunner.ts` core lifecycle

**Severity:** HIGH  
**Scope:** 1 new test file  
**Dependencies:** P0-2 (uncaughtException fix)

**Steps:**
1. Create `server/src/swarm/blackboard/BlackboardRunner.lifecycle.test.ts`
2. Test cases:
   - `start()` → transitions from idle → running
   - `stop()` → transitions from running → stopping → stopped
   - `drain()` → transitions from running → draining → stopping → stopped
   - `drain()` after `stop()` → stays stopping (drain doesn't override stop)
   - `stop()` after `drain()` → escalates to stopping
   - `_wasDrained` flag is sticky
   - `classifyStopReason` returns correct values for each terminal state
   - Concurrent `start()` calls are idempotent
   - `killAll()` broadcasts "stopped" before setting `killed=true`
3. Use `testScaffolding` for mock context construction.

**Acceptance:** 10+ test cases covering all lifecycle transitions. Tests pass.

---

### P2-4. Unit tests for providers

**Severity:** MEDIUM  
**Scope:** 4 new test files  
**Dependencies:** None

**Steps:**
1. Create `server/src/providers/OllamaProvider.test.ts`:
   - `chat()` sends correct request shape
   - `chat()` handles streaming responses
   - `chat()` handles `format` parameter
   - `chat()` handles error responses (429, 500)
2. Create `server/src/providers/OllamaCloudProvider.test.ts`:
   - `chat()` sends Bearer auth
   - `chat()` handles cloud-specific errors
3. Create `server/src/providers/AnthropicProvider.test.ts`:
   - `chat()` sends correct headers
   - `chat()` handles `x-api-key` auth
4. Create `server/src/providers/OpenAIProvider.test.ts`:
   - `chat()` sends correct request shape
   - `chat()` handles `format` parameter passthrough
5. Use `nock` or similar for HTTP mocking (add as devDependency).

**Acceptance:** Each provider has 5+ test cases covering happy path and error handling.

---

### P2-5. Unit tests for `OTEngine.ts`

**Severity:** MEDIUM  
**Scope:** 1 new test file  
**Dependencies:** None

**Steps:**
1. Create `server/src/swarm/streamMerge/OTEngine.test.ts`
2. Test cases:
   - Concurrent inserts at different positions
   - Concurrent inserts at same position (last-writer-wins)
   - Delete after insert at same position
   - Delete range spanning multiple operations
   - Transform of operations with different base versions
   - Idempotency: applying same operation twice is safe
3. Use property-based testing for fuzzy inputs (optional but recommended).

**Acceptance:** OT transform produces correct results for 10+ scenarios.

---

### P2-6. Integration test for `continuousMode.ts`

**Severity:** LOW-MEDIUM  
**Scope:** 1 new test file  
**Dependencies:** None

**Steps:**
1. Create `server/src/routes/continuousMode.test.ts`
2. Test:
   - `/api/swarm/continuous` validates body
   - Continuous mode starts and stops correctly
   - Error handling for invalid state transitions
3. Use supertest or similar for HTTP-level testing.

**Acceptance:** 5+ test cases for continuous mode route.

---

## P3 — Lower Priority ( shipped as time permits )

### P3-1. API versioning strategy

**Severity:** MEDIUM  
**Scope:** Route restructuring  
**Dependencies:** None

**Steps:**
1. Add `/api/v1/` prefix to all existing `/api/swarm` routes using Express router:
   ```ts
   const v1Router = express.Router();
   // ... move all swarm routes to v1Router
   app.use("/api/v1", v1Router);
   ```
2. Add backward-compatible redirect from `/api/swarm/*` to `/api/v1/*` with 301 status:
   ```ts
   app.use("/api/swarm", (req, res) => {
     res.redirect(301, `/api/v1${req.path}`);
   });
   ```
3. Keep `/api/v2` routes as-is (they're already versioned).
4. Update web client to use `/api/v1/` prefix.
5. Keep `/api/health`, `/api/models`, `/api/usage`, `/api/providers` unversioned (infrastructure).

**Acceptance:** All swarm routes accessible under `/api/v1/`. Old `/api/swarm/` paths redirect. Web client updated.

---

### P3-2. WebSocket authentication

**Severity:** MEDIUM (localhost-only deployment mitigates)  
**Scope:** 2 files (`broadcast.ts`, `index.ts`)  
**Dependencies:** None

**Steps:**
1. Accept `?token=` query param on WS upgrade (same value as `OPENCODE_SERVER_PASSWORD`).
2. In `Broadcaster.attach()`, validate token before allowing connection:
   ```ts
   wss.on("connection", (ws, req) => {
     const token = new URL(req.url!, `http://localhost`).searchParams.get("token");
     if (token !== config.OPENCODE_SERVER_PASSWORD) {
       ws.close(4001, "Unauthorized");
       return;
     }
     // ... existing client setup
   });
   ```
3. Update web client to pass `token` in WS connection URL.
4. Keep `runId` filter working alongside `token`.

**Acceptance:** Unauthenticated WS connections are rejected with 4001. Authenticated connections work as before.

---

### P3-3. CORS configuration

**Severity:** LOW (localhost-only deployment)  
**Scope:** 1 file (`index.ts`) + 1 dependency  
**Dependencies:** `cors` package

**Steps:**
1. `npm install cors @types/cors`
2. In `index.ts`:
   ```ts
   import cors from "cors";
   app.use(cors({
     origin: [`http://localhost:${config.SERVER_PORT}`, `http://127.0.0.1:${config.SERVER_PORT}`],
     methods: ["GET", "POST", "DELETE"],
   }));
   ```
3. Add `CORS_ORIGINS` env var to `config.ts` for custom origins.

**Acceptance:** Browser requests from allowed origins succeed. Requests from other origins get CORS rejection.

---

### P3-4. Security headers middleware

**Severity:** LOW  
**Scope:** 1 new file + `index.ts` integration  
**Dependencies:** `helmet` package (or manual headers)

**Steps:**
1. Option A (lightweight): Add manual security headers without a dependency:
   ```ts
   app.use((_req, res, next) => {
     res.setHeader("X-Content-Type-Options", "nosniff");
     res.setHeader("X-Frame-Options", "DENY");
     res.setHeader("X-XSS-Protection", "1; mode=block");
     next();
   });
   ```
2. Option B (full): `npm install helmet` + `app.use(helmet())`.
3. Recommended: Option A (no dependency, minimal headers, sufficient for localhost deployment).

**Acceptance:** Security headers present in all responses.

---

### P3-5. Request logging middleware

**Severity:** LOW  
**Scope:** 1 new file + `index.ts` integration  
**Dependencies:** None

**Steps:**
1. Create `server/src/middleware/requestLogger.ts`:
   ```ts
   import type { Request, Response, NextFunction } from "express";
   export function requestLogger(req: Request, res: Response, next: NextFunction): void {
     const start = Date.now();
     res.on("finish", () => {
       const ms = Date.now() - start;
       const level = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
       console.log(`[${level}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
     });
     next();
   }
   ```
2. Mount in `index.ts`: `app.use(requestLogger)` before routes.

**Acceptance:** All HTTP requests logged with method, path, status, and duration.

---

### P3-6. HTTP compression middleware

**Severity:** LOW  
**Scope:** 1 dependency + 1 line in `index.ts`  
**Dependencies:** `compression` package

**Steps:**
1. `npm install compression @types/compression`
2. In `index.ts`: `app.use(compression())` before routes.

**Acceptance:** Response bodies compressed with gzip for clients that accept it.

---

## Refactoring Plans

### R1. `BlackboardRunnerFields = any` — incremental typing

**Scope:** `BlackboardRunner.ts` + 5 context builder functions  
**Current state:** 126 property accesses on `any` type  
**Dependencies:** P1-2 (context types)

**Plan:**
1. Create `server/src/swarm/blackboard/BlackboardRunnerTypes.ts` with typed interfaces for:
   - `PlannerContext` (already exists, just needs `any` removal)
   - `ContractContext` (already exists)
   - `AuditorContext` (already exists)
   - `WorkerContext` (already exists)
   - `ReplanContext` (already exists)
   - `TierContext` (new — currently inline in `tierRunner.ts`)
   - `CapContext` (new — currently inline in `capManager.ts`)
   - `PromptContext` (already exists in `promptRunner.ts`)
   - `LifecycleContext` (new — currently inline in `lifecycleRunner.ts`)
2. Remove `BlackboardRunnerFields = any` comment from `BlackboardRunner.ts`.
3. For each context builder function, replace `any` return type with the proper interface.
4. Incrementally: convert one context at a time, run tests, commit. Don't try to convert all 126 accesses at once.
5. Target timeline: 2-3 contexts per sprint.

**Acceptance:** `BlackboardRunnerFields = any` type alias removed. All context builders return properly typed objects. `tsc` passes.

---

### R2. Error response standardization

**Scope:** All route handlers in `swarm.ts`, `v2.ts`, `index.ts`  
**Current state:** 4 different error shapes: `{ error: string }`, `{ error: ZodError.flatten() }`, `{ error, ok }`, plain 500 HTML

**Plan:**
1. Create `server/src/middleware/apiResponse.ts`:
   ```ts
   export interface ApiError { error: string; ok: false; details?: unknown; }
   export interface ApiSuccess<T> { data: T; ok: true; }
   export type ApiResponse<T> = ApiSuccess<T> | ApiError;
   
   export function apiError(res: Response, status: number, message: string, details?: unknown): Response {
     return res.status(status).json({ error: message, ok: false, ...(details ? { details } : {}) });
   }
   export function apiSuccess<T>(res: Response, data: T, status = 200): Response {
     return res.status(status).json({ data, ok: true });
   }
   ```
2. Migrate routes one at a time, starting with `/api/swarm/start` (already uses Zod).
3. Don't break backward compatibility — keep `error` field as string for clients that depend on it.

**Acceptance:** All API responses conform to `{ ok: boolean, data?: T, error?: string, details?: unknown }`. No raw HTML 500 responses.

---

### R3. Test infrastructure for web components

**Scope:** New test infrastructure in `web/src/`  
**Current state:** 4 test files out of ~65 source files (6% coverage)

**Plan:**
1. Add testing infrastructure:
   - Install `vitest` + `@testing-library/react` + `@testing-library/jest-dom` + `jsdom` as devDependencies.
   - Create `web/vitest.config.ts` with `jsdom` environment.
   - Add `"test": "vitest run"` script to `web/package.json`.
   - Add `"test": "npm -w server run test && npm -w web run test"` to root `package.json`.
2. Write critical path tests first (not all 65 components):
   - `state/applyEvent.test.ts` (highest priority — event reducer)
   - `hooks/useSwarmSocket.test.ts` (WS connection)
   - `hooks/useReplayState.test.ts` (already exists, ensure it runs in vitest)
   - `components/BoardView.test.tsx` (board rendering)
   - `components/SetupForm.test.tsx` (form validation)
   - `components/BubbleGallery.test.tsx` (transcript rendering)
3. Use the shared Zod schemas from `wsProtocol.ts` to generate test events.

**Acceptance:** `npm test` runs both server + web test suites. Web has 6+ new test files covering critical paths.

---

### R4. Deduplicate prompt helper modules

**Scope:** 8 prompt helper files with `emitOutcome: (outcome: any)`  
**Current state:** 8 near-identical copy-paste blocks

**Plan:**
1. Create `server/src/swarm/runnerSharedTypes.ts` with shared interfaces:
   - `OutcomeScoredEvent` type
   - `DiscussionRunnerConfig` common fields
   - `EmitOutcomeFn` type alias
2. In each runner file, replace `emitOutcome: (outcome: any) => void` with `emitOutcome: EmitOutcomeFn`.
3. Extract shared prompt construction helpers (e.g., `buildProposerPrompt`, `buildAggregatorPrompt`) if they have cross-runner duplication.
4. Run `tsc` and tests after each runner file conversion.

**Acceptance:** Zero `outcome: any` in the codebase. Shared types are imported, not copy-pasted.

---

### R5. Merge duplicate `wsProtocol` types into shared

**Scope:** `server/src/types.ts`, `web/src/types.ts`, `shared/src/wsProtocol.ts`  
**Current state:** `SwarmEvent` and `AgentState` defined independently in 3 places

**Plan:**
1. `shared/src/wsProtocol.ts` already has Zod schemas for all wire-protocol types. Verify it covers all variants in `server/src/types.ts` and `web/src/types.ts`.
2. In `server/src/types.ts`, replace hand-maintained interfaces with `z.infer<typeof SwarmEventSchema>` re-exports from shared.
3. In `web/src/types.ts`, same re-export approach.
4. Keep server-only types (like `RunConfig`, `Agent`) in `server/src/types.ts` — don't move them to shared.
5. Remove duplicate type definitions.
6. Run `tsc` after each file change.

**Acceptance:** Wire-protocol types defined once in `shared/src/wsProtocol.ts`, inferred via `z.infer` in both server and web. No duplicate definitions.

---

### R6. Unify `empty catch` handling pattern

**Scope:** ~128 catch blocks  
**Current state:** Mix of `catch {}`, `catch { /* skip */ }`, `catch (e) { /* log */ }`, `catch {}` with no logging

**Plan:**
1. After P1-1 (logging pass), remaining silent catches should have explicit `// intentional: <reason>` comments.
2. Create an ESLint rule (or code review checklist) that flags `catch` blocks with fewer than 3 words of explanation.
3. Categories of intentional silent catches:
   - **Best-effort I/O**: File reads, git operations, cleanup — log at debug level only.
   - **Graceful degradation**: Non-critical feature failures — log at warn level.
   - **Race conditions**: State that may have changed between check and use — log at debug level.
4. For each remaining silent catch, add either `appendSystem(...)` / `console.error(...)` or a comment explaining why it's intentionally suppressed.

**Acceptance:** Every `catch` block contains either a logging call or a comment starting with `// intentional:`.

---

## Summary Priority Matrix

| ID | Priority | Description | Scope Estimate |
|----|----------|-------------|----------------|
| P0-1 | Critical | Global Express error handler | 1 file, ~40 LOC |
| P0-2 | Critical | Fix uncaughtException to exit | 1 file, ~10 LOC |
| P0-3 | Critical | Rate limiting on write endpoints | 2 files, ~50 LOC |
| P0-4 | Critical | Zod validation on all routes | 2 files, ~200 LOC |
| P1-1 | High | Log 128 empty catch blocks | ~20 files, ~200 LOC |
| P1-2 | High | Type `contextBuilders.ts` | 2 files, ~100 LOC |
| P1-3 | High | Extract `emitOutcome` shared type | 9 files, ~80 LOC |
| P1-4 | High | Extract hardcoded URLs | 4 files, ~20 LOC |
| P1-5 | High | WS heartbeat + maxPayload | 2 files, ~40 LOC |
| P2-1 | Medium | Tests: `applyEvent.ts` | 1 file, ~200 LOC |
| P2-2 | Medium | Tests: `SwarmRunner.ts` + `DiscussionRunnerBase.ts` | 2 files, ~400 LOC |
| P2-3 | Medium | Tests: `BlackboardRunner.ts` lifecycle | 1 file, ~200 LOC |
| P2-4 | Medium | Tests: 4 providers | 4 files, ~300 LOC |
| P2-5 | Medium | Tests: `OTEngine.ts` | 1 file, ~150 LOC |
| P2-6 | Medium | Tests: `continuousMode.ts` | 1 file, ~100 LOC |
| P3-1 | Low | API versioning | 3 files, ~100 LOC |
| P3-2 | Low | WS authentication | 2 files, ~30 LOC |
| P3-3 | Low | CORS configuration | 2 files, ~15 LOC |
| P3-4 | Low | Security headers | 2 files, ~15 LOC |
| P3-5 | Low | Request logging middleware | 2 files, ~20 LOC |
| P3-6 | Low | HTTP compression | 2 files, ~5 LOC |
| R1 | Refactor | `BlackboardRunnerFields = any` typing | 5+ files, incremental |
| R2 | Refactor | Error response standardization | 3 files, ~80 LOC |
| R3 | Refactor | Web test infrastructure | 6+ files, ~500 LOC |
| R4 | Refactor | Deduplicate `emitOutcome` | 9 files, ~80 LOC |
| R5 | Refactor | Merge `wsProtocol` types | 3 files, ~100 LOC |
| R6 | Refactor | Unify empty catch handling | ~20 files, review |

**Total estimated scope:** ~2,500 LOC new/modified across ~50 files.

**Recommended shipment order:**
1. P0-1 + P0-2 (error handling — 1 hour) 
2. P0-3 + P0-4 (rate limiting + validation — 2-3 hours)
3. P1-2 + P1-3 + P1-4 (type safety — 2 hours)
4. P1-5 (WS heartbeat — 1 hour)
5. P1-1 (catch block logging — 3-4 hours, can be split across sprints)
6. P2-1 through P2-6 (tests — 1 sprint)
7. R1 + R5 (type refactoring — 1 sprint, incremental)
8. P3-* (ops hardening — as time permits)
9. R2–R6 (refactoring — ongoing, incremental)