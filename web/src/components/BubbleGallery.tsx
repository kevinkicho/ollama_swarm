// Validation tour fixture (2026-04-27). Renders one example of every
// summary.kind variant + every client-fallback shape so the audit can
// verify rendering in isolation without waiting for runs to surface
// each kind organically. Wired via ?gallery=1 in App.tsx.
//
// Each fixture is hand-crafted from the discriminated union in
// shared/src/transcriptEntrySummary.ts. Hand-crafting (not derived from
// real run data) keeps the gallery deterministic and audit-friendly.

import type { TranscriptEntry, TranscriptEntrySummary } from "../types";
import { MessageBubble } from "./transcript/MessageBubble";

let idSeq = 1;
function entry(partial: Partial<TranscriptEntry> & { text: string }): TranscriptEntry {
  return {
    id: `gallery-${idSeq++}`,
    role: "agent",
    agentIndex: 1,
    ts: Date.now(),
    ...partial,
  };
}

const sumWorkerHunks: Extract<TranscriptEntrySummary, { kind: "worker_hunks" }> = {
  kind: "worker_hunks",
  hunkCount: 3,
  ops: { replace: 2, create: 1, append: 0 },
  firstFile: "src/foo/bar.ts",
  multipleFiles: true,
  totalChars: 1240,
};

const sumWorkerSkip: Extract<TranscriptEntrySummary, { kind: "worker_skip" }> = {
  kind: "worker_skip",
  reason: "no diff produced - target file not found",
};

const sumOWAssignments: Extract<TranscriptEntrySummary, { kind: "ow_assignments" }> = {
  kind: "ow_assignments",
  subtaskCount: 3,
  assignments: [
    { agentIndex: 2, subtask: "Refactor request handler in src/handlers/api.ts to use async/await" },
    { agentIndex: 3, subtask: "Add input validation to src/handlers/api.ts route params" },
    { agentIndex: 4, subtask: "Update src/handlers/api.test.ts to cover new validation paths" },
  ],
};

const sumCouncilDraft: Extract<TranscriptEntrySummary, { kind: "council_draft" }> = {
  kind: "council_draft",
  round: 2,
  phase: "reveal",
};

const sumDebateTurn: Extract<TranscriptEntrySummary, { kind: "debate_turn" }> = {
  kind: "debate_turn",
  round: 3,
  role: "pro",
};

const sumCouncilSynthesis: Extract<TranscriptEntrySummary, { kind: "council_synthesis" }> = {
  kind: "council_synthesis",
  rounds: 3,
};

const sumStigmergyReport: Extract<TranscriptEntrySummary, { kind: "stigmergy_report" }> = {
  kind: "stigmergy_report",
  filesRanked: 17,
};

const sumRoleDiffSynthesis: Extract<TranscriptEntrySummary, { kind: "role_diff_synthesis" }> = {
  kind: "role_diff_synthesis",
  rounds: 2,
  roles: 4,
};

const sumNextActionAnnounce: Extract<TranscriptEntrySummary, { kind: "next_action_phase" }> = {
  kind: "next_action_phase",
  role: "announcement",
};
const sumNextActionImpl: Extract<TranscriptEntrySummary, { kind: "next_action_phase" }> = {
  kind: "next_action_phase",
  role: "implementer",
};
const sumNextActionReview: Extract<TranscriptEntrySummary, { kind: "next_action_phase" }> = {
  kind: "next_action_phase",
  role: "reviewer",
};
const sumNextActionSignoff: Extract<TranscriptEntrySummary, { kind: "next_action_phase" }> = {
  kind: "next_action_phase",
  role: "signoff",
};

const sumDebateVerdict: Extract<TranscriptEntrySummary, { kind: "debate_verdict" }> = {
  kind: "debate_verdict",
  round: 3,
  winner: "pro",
  confidence: "high",
  proStrongest: "Empirical evidence from production logs supports the immediate cutover (47% latency reduction observed).",
  conStrongest: "Rollback risk is non-trivial — the feature flag adds 2 days of buffer in case the cutover surfaces edge cases.",
  proWeakest: "Did not address the lock-contention regression that surfaced in week-3 telemetry.",
  conWeakest: "Telemetry data was inconclusive on the gradual-rollout dimension; no measurable improvement.",
  decisive: "PRO's empirical data is concrete and quantifiable; CON's risk argument is hypothetical.",
  nextAction: "Implement the immediate cutover guarded by the rollback flag CON proposed.",
};

const sumMapReduceSynthesis: Extract<TranscriptEntrySummary, { kind: "mapreduce_synthesis" }> = {
  kind: "mapreduce_synthesis",
  cycle: 2,
};

const sumRunFinished: Extract<TranscriptEntrySummary, { kind: "run_finished" }> = {
  kind: "run_finished",
  runId: "0fa1dd98-1315-45a4-80d4-833735ac8cde",
  preset: "blackboard",
  model: "glm-5.1:cloud",
  repoUrl: "https://github.com/kevinkicho/multi-agent-orchestrator",
  clonePath: "C:\\Users\\kevin\\Desktop\\ollama_swarm\\runs\\multi-agent-orchestrator",
  startedAt: Date.now() - 1042836,
  endedAt: Date.now(),
  wallClockMs: 1042836,
  stopReason: "completed",
  stopDetail: "auditor invocation cap reached (5)",
  filesChanged: 1,
  commits: 29,
  totalTodos: 35,
  skippedTodos: 6,
  staleEvents: 10,
  linesAdded: 142,
  linesRemoved: 17,
  totalPromptTokens: 712034,
  totalResponseTokens: 55848,
  agents: [
    { agentIndex: 1, role: "Planner", turns: 22, attempts: 22, retries: 0, meanLatencyMs: 6906, commits: 0, linesAdded: 0, linesRemoved: 0, rejected: 0, jsonRepairs: 0, promptErrors: 0, tokensIn: 105885, tokensOut: 16749 },
    { agentIndex: 2, role: "Worker", turns: 15, attempts: 15, retries: 0, meanLatencyMs: 11770, commits: 12, linesAdded: 64, linesRemoved: 17, rejected: 3, jsonRepairs: 0, promptErrors: 0, tokensIn: 45782, tokensOut: 5645 },
    { agentIndex: 3, role: "Worker", turns: 12, attempts: 12, retries: 0, meanLatencyMs: 28604, commits: 6, linesAdded: 54, linesRemoved: 0, rejected: 5, jsonRepairs: 1, promptErrors: 0, tokensIn: 86598, tokensOut: 15237 },
    { agentIndex: 4, role: "Worker", turns: 8, attempts: 8, retries: 0, meanLatencyMs: 18904, commits: 11, linesAdded: 24, linesRemoved: 0, rejected: 1, jsonRepairs: 0, promptErrors: 0, tokensIn: 22000, tokensOut: 3500 },
    { agentIndex: 5, role: "Auditor", turns: 5, attempts: 5, retries: 0, meanLatencyMs: 32100, commits: 0, linesAdded: 0, linesRemoved: 0, rejected: 0, jsonRepairs: 0, promptErrors: 0, tokensIn: 451769, tokensOut: 14817 },
  ],
};

const sumSeedAnnounce: Extract<TranscriptEntrySummary, { kind: "seed_announce" }> = {
  kind: "seed_announce",
  repoUrl: "https://github.com/kevinkicho/multi-agent-orchestrator",
  clonePath: "C:\\Users\\kevin\\Desktop\\ollama_swarm\\runs\\multi-agent-orchestrator",
  topLevel: ["src/", "tests/", "package.json", "tsconfig.json", "README.md", "LICENSE", ".gitignore"],
};

const sumStretchGoals: Extract<TranscriptEntrySummary, { kind: "stretch_goals" }> = {
  kind: "stretch_goals",
  goals: [
    "Refactor BlackboardRunner.ts: split 3300-LOC god-class into RunState + lifecycle modules to lift the refactor floor noted in #164",
    "Add E2E test for the planner sibling-model fallback path so the regression detector catches the edge case automatically",
    "Wire the V2 EventLogReader into the live UI so state derivation skips the WebSocket snapshot path",
  ],
  tier: 2,
  committed: 12,
};

const sumVerifierVerified: Extract<TranscriptEntrySummary, { kind: "verifier_verdict" }> = {
  kind: "verifier_verdict",
  verdict: "verified",
  proposingAgentId: "agent-2",
  todoDescription: "Refactor src/foo.ts to use async/await pattern instead of nested promise chains",
  evidenceCitation: "src/foo.ts L47-L62 (8 await calls in commit 4f5e93a, was 8 .then chains)",
  rationale: "All Promise.then() calls in the targeted block were converted to await; existing tests still pass.",
};
const sumVerifierPartial: Extract<TranscriptEntrySummary, { kind: "verifier_verdict" }> = {
  kind: "verifier_verdict",
  verdict: "partial",
  proposingAgentId: "agent-3",
  todoDescription: "Add input validation for all REST endpoints in src/handlers/",
  evidenceCitation: "src/handlers/users.ts L23, L41 (2 of 5 endpoints validated)",
  rationale: "Only the user-routes were updated; orders + sessions handlers still untouched.",
};
const sumVerifierFalse: Extract<TranscriptEntrySummary, { kind: "verifier_verdict" }> = {
  kind: "verifier_verdict",
  verdict: "false",
  proposingAgentId: "agent-4",
  todoDescription: "Migrate database connection pooling to use the new pool.ts abstraction",
  evidenceCitation: "src/db/pool.ts (NOT FOUND - file does not exist in repo)",
  rationale: "The proposed file does not exist; the worker hallucinated the abstraction it was migrating to.",
};
const sumVerifierUnverifiable: Extract<TranscriptEntrySummary, { kind: "verifier_verdict" }> = {
  kind: "verifier_verdict",
  verdict: "unverifiable",
  proposingAgentId: "agent-2",
  todoDescription: "Improve overall code quality and reduce technical debt across the codebase",
  evidenceCitation: "(no specific file citation; vague todo)",
  rationale: "Todo description is too vague to verify against any concrete code change.",
};

const sumQuotaPaused: Extract<TranscriptEntrySummary, { kind: "quota_paused" }> = {
  kind: "quota_paused",
  statusCode: 503,
  reason: "Ollama returned 503 — quota wall hit; pausing planner pump until ready",
};
const sumQuotaResumed: Extract<TranscriptEntrySummary, { kind: "quota_resumed" }> = {
  kind: "quota_resumed",
  pausedMs: 312_000,
  totalPausedMs: 312_000,
};

const sumAgentsReady: Extract<TranscriptEntrySummary, { kind: "agents_ready" }> = {
  kind: "agents_ready",
  preset: "blackboard",
  readyCount: 5,
  requestedCount: 5,
  spawnElapsedMs: 28_400,
  agents: [
    { id: "agent-1", index: 1, port: 41201, model: "glm-5.1:cloud", sessionId: "ses_abc123def456ghi789jklmnopqrstuvwxyz", role: "Planner", warmupMs: 22_400 },
    { id: "agent-2", index: 2, port: 41203, model: "glm-5.1:cloud", sessionId: "ses_xyz789uvw456rst123onmlkjihgfedcba0987", role: "Worker", warmupMs: 25_100 },
    { id: "agent-3", index: 3, port: 41205, model: "glm-5.1:cloud", sessionId: "ses_qrs456tuv789wxy123zabcdefghijklmnop4321", role: "Worker", warmupMs: 27_800 },
    { id: "agent-4", index: 4, port: 41207, model: "glm-5.1:cloud", sessionId: "ses_lmn012opq345rst678uvwxyzabcdefghijkl5678", role: "Worker", warmupMs: 35_200 },
    { id: "agent-5", index: 5, port: 41209, model: "glm-5.1:cloud", sessionId: "ses_efg678hij901klm234nopqrstuvwxyzabcdef9012", role: "Auditor", warmupMs: 26_900 },
  ],
};

// Synthetic raw-text payloads for envelope kinds the client-side
// summarizer parses (contract / auditor / todos).
const contractEnvelope = JSON.stringify({
  missionStatement: "Refactor the monolithic request handler in src/handlers/api.ts into separate per-route modules following SRP. Add input validation to each new module and ensure existing API contracts remain unchanged.",
  criteria: [
    { description: "src/handlers/api.ts is split into per-route modules under src/handlers/routes/", expectedFiles: ["src/handlers/api.ts", "src/handlers/routes/users.ts", "src/handlers/routes/orders.ts"] },
    { description: "Each per-route module has zod input validation on its public handler", expectedFiles: ["src/handlers/routes/users.ts", "src/handlers/routes/orders.ts"] },
    { description: "Existing tests under src/handlers/__tests__/ pass without modification", expectedFiles: ["src/handlers/__tests__/api.test.ts"] },
    { description: "New unit tests cover the input-validation paths for each module", expectedFiles: ["src/handlers/routes/__tests__/users.test.ts", "src/handlers/routes/__tests__/orders.test.ts"] },
    { description: "Type signatures of exported functions in src/handlers/index.ts remain unchanged for backward compatibility", expectedFiles: ["src/handlers/index.ts"] },
    { description: "README.md is updated with the new module layout under 'Architecture'", expectedFiles: ["README.md"] },
  ],
}, null, 2);

const auditorEnvelope = JSON.stringify({
  verdicts: [
    { id: "C1", status: "met", rationale: "src/handlers/api.ts now imports + delegates to /routes/users.ts and /routes/orders.ts; the original logic moved cleanly into those modules." },
    { id: "C2", status: "met", rationale: "Both route modules have zod schemas defined at the top and apply them via .parse() before invoking handler logic." },
    { id: "C3", status: "met", rationale: "All 12 tests in api.test.ts still pass after the refactor (verified via npm test)." },
    { id: "C4", status: "unmet", rationale: "users.test.ts exists but only covers happy path; no negative validation tests. orders.test.ts is missing entirely." },
    { id: "C5", status: "met", rationale: "src/handlers/index.ts exports unchanged; downstream callers in src/server.ts compile without modification." },
    { id: "C6", status: "wont-do", rationale: "README.md not updated; this is a doc-only criterion that doesn't block functional correctness." },
    { id: "C7", status: "unmet", rationale: "Lint warnings about unused imports in src/handlers/api.ts post-refactor (4 warnings). Fix in follow-up.", todos: [{ description: "Remove unused imports in src/handlers/api.ts" }] },
  ],
  newCriteria: [
    { description: "Add a CHANGELOG.md entry documenting the breaking change to import paths if any consumers used the routes directly", expectedFiles: ["CHANGELOG.md"] },
    { description: "Run `npm run lint` and resolve the 4 unused-import warnings flagged in C7", expectedFiles: ["src/handlers/api.ts"] },
  ],
}, null, 2);

// Real planner shape: top-level array of {description, expectedFiles, expectedSymbols?}.
// (NOT wrapped in {todos: [...]} — the parser at shared/summarizeAgentJson.ts:247
// only matches Array.isArray(parsed).)
const todosEnvelope = JSON.stringify([
  { description: "Identify the request handler that needs refactoring (should be src/handlers/api.ts)", expectedFiles: ["src/handlers/api.ts"], expectedSymbols: ["api"] },
  { description: "Create src/handlers/routes/users.ts with the user-related route handlers extracted from api.ts", expectedFiles: ["src/handlers/routes/users.ts", "src/handlers/api.ts"], expectedSymbols: ["users"] },
  { description: "Create src/handlers/routes/orders.ts with the order-related route handlers extracted from api.ts", expectedFiles: ["src/handlers/routes/orders.ts", "src/handlers/api.ts"], expectedSymbols: ["orders"] },
  { description: "Add zod input validation schemas to both new route modules", expectedFiles: ["src/handlers/routes/users.ts", "src/handlers/routes/orders.ts"] },
  { description: "Verify that the existing api.test.ts tests still pass against the refactored modules", expectedFiles: ["src/handlers/__tests__/api.test.ts"] },
], null, 2);

const workerHunksRawJson = JSON.stringify({
  hunks: [
    { op: "replace", file: "src/foo/bar.ts", search: "function getUser(id: string) {\n  return db.users.findOne({ id });\n}", replace: "async function getUser(id: string) {\n  const user = await db.users.findOne({ id });\n  if (!user) throw new NotFoundError(`user ${id}`);\n  return user;\n}" },
    { op: "replace", file: "src/foo/bar.ts", search: "function listUsers() {\n  return db.users.findAll();\n}", replace: "async function listUsers() {\n  return await db.users.findAll();\n}" },
    { op: "create", file: "src/foo/errors.ts", content: "export class NotFoundError extends Error {\n  constructor(what: string) {\n    super(`not found: ${what}`);\n    this.name = 'NotFoundError';\n  }\n}\n" },
  ],
}, null, 2);

const proseTextWithThoughts = "After scanning the request handler, the cleanest split is by domain: users, orders, sessions. Each gets its own file under src/handlers/routes/ with a zod schema at the top. The api.ts file becomes a thin barrel that imports + re-exports the handlers under their original names so downstream consumers don't break.";

const fixtures: Array<{ label: string; entries: TranscriptEntry[] }> = [
  // ─── System bubbles ───
  {
    label: "[system] run_finished (RunFinishedGrid)",
    entries: [entry({ role: "system", text: "═══ Run finished ═══", summary: sumRunFinished })],
  },
  {
    label: "[system] seed_announce (SeedAnnounceGrid)",
    entries: [entry({ role: "system", text: "Cloned multi-agent-orchestrator. Top-level entries: src/, tests/, package.json, …", summary: sumSeedAnnounce })],
  },
  {
    label: "[system] verifier_verdict (4 colors: verified / partial / false / unverifiable)",
    entries: [
      entry({ role: "system", text: "verifier verdict: verified", summary: sumVerifierVerified }),
      entry({ role: "system", text: "verifier verdict: partial", summary: sumVerifierPartial }),
      entry({ role: "system", text: "verifier verdict: false", summary: sumVerifierFalse }),
      entry({ role: "system", text: "verifier verdict: unverifiable", summary: sumVerifierUnverifiable }),
    ],
  },
  {
    label: "[system] agents_ready (AgentsReadyBubble - click 'details' to expand grid)",
    entries: [entry({ role: "system", text: "5/5 agents ready on ports 41201, 41203, 41205, 41207, 41209", summary: sumAgentsReady })],
  },
  {
    label: "[system] recovery notice (amber chip - regex match in SystemBubble)",
    entries: [entry({ role: "system", text: "did not parse — Issuing repair prompt to agent-2 (attempt 2/3)", ts: Date.now() })],
  },
  {
    label: "[system] generic system text (CollapsibleBlock fallback)",
    entries: [entry({ role: "system", text: "Replanner deferred — auditor cap not yet reached, continuing executing phase.", ts: Date.now() })],
  },
  {
    label: "[user] user message (CollapsibleBlock)",
    entries: [entry({ role: "user", text: "Please refactor src/foo.ts to use async/await throughout.", ts: Date.now() })],
  },

  // ─── Server-summary agent bubbles ───
  {
    label: "[agent] worker_hunks (WorkerHunksBubble - click 'Show diff' for inline)",
    entries: [entry({ role: "agent", agentIndex: 2, text: workerHunksRawJson, summary: sumWorkerHunks })],
  },
  {
    label: "[agent] worker_skip (AgentJsonBubble fallback)",
    entries: [entry({ role: "agent", agentIndex: 3, text: JSON.stringify({ skip: true, reason: "no diff produced" }, null, 2), summary: sumWorkerSkip })],
  },
  {
    label: "[agent] ow_assignments (AgentJsonBubble)",
    entries: [entry({ role: "agent", agentIndex: 1, text: JSON.stringify({ assignments: sumOWAssignments.assignments }, null, 2), summary: sumOWAssignments })],
  },
  {
    label: "[agent] council_draft (chip + CollapsibleBlock prose)",
    entries: [entry({ role: "agent", agentIndex: 2, text: "My take on the architecture decision: the split-by-domain proposal preserves the original imports cleanly, but the LCD-by-feature alternative would actually scale better when we add more domains downstream. I'd lean toward starting with split-by-domain and migrating to feature-folders if/when we add more than 5 domains.", summary: sumCouncilDraft })],
  },
  {
    label: "[agent] debate_turn (chip + CollapsibleBlock prose)",
    entries: [entry({ role: "agent", agentIndex: 2, text: "PRO position: the immediate cutover gives us the fastest possible feedback loop. Telemetry from the past 30 days shows that 73% of latency-sensitive paths route through the affected handler. Delaying by 2 weeks (CON's proposal) costs us $4.2k in compute overhead at current volume. The migration risk is bounded — we've benched the new code path against the old in staging for 3 weeks with zero divergences.", summary: sumDebateTurn })],
  },
  {
    label: "[agent] council_synthesis (DecoratedSynthesisBlock - emerald)",
    entries: [entry({ role: "agent", agentIndex: 1, text: "Consensus across 4 drafters: split by domain (users/orders/sessions) over feature-folders. All 4 cited the import-path stability as the deciding factor.\n\nDisagreement: 2 of 4 wanted README updated as part of the split; the other 2 wanted that as a separate commit.\n\nNext action: agent-2 implements split-by-domain; agent-3 adds README update in a follow-up commit.", summary: sumCouncilSynthesis })],
  },
  {
    label: "[agent] stigmergy_report (DecoratedSynthesisBlock - sky)",
    entries: [entry({ role: "agent", agentIndex: 1, text: "Top findings (pheromone density):\n  1. src/handlers/api.ts (37 marks) — central hot spot, refactor target\n  2. src/db/connection.ts (22 marks) — secondary; pool reuse opportunity\n  3. tests/integration/api.test.ts (18 marks) — needs expansion post-refactor\n\nCoverage: 17/24 files inspected; remaining 7 are config + types-only.\n\nNext action: focus on api.ts split as primary work; pool refactor as bonus.", summary: sumStigmergyReport })],
  },
  {
    label: "[agent] mapreduce_synthesis (DecoratedSynthesisBlock - violet)",
    entries: [entry({ role: "agent", agentIndex: 1, text: "Map-reduce cycle 2 synthesis: combining the two parallel mapper outputs reveals that both paths converged on the same architectural conclusion (split-by-domain). The reducer's recommendation is to proceed with the higher-confidence variant (mapper A, confidence 0.91) and skip the third map-reduce cycle.", summary: sumMapReduceSynthesis })],
  },
  {
    label: "[agent] role_diff_synthesis (DecoratedSynthesisBlock - amber)",
    entries: [entry({ role: "agent", agentIndex: 1, text: "4-role consolidation across 2 rounds:\n\nArchitect: prefers split-by-domain for symmetry with existing folder structure.\nReviewer: flagged risk of import-path drift; recommends a CHANGELOG entry.\nTester: notes that current test fixtures will need refactoring to match the split.\nUser-advocate: emphasizes preserving the public API surface area.\n\nConvergence: all 4 align on split-by-domain WITH a CHANGELOG entry. No further rounds needed.", summary: sumRoleDiffSynthesis })],
  },
  {
    label: "[agent] next_action_phase: announcement (compact indigo)",
    entries: [entry({ role: "agent", agentIndex: 1, text: "Build phase begins: PRO becomes implementer, CON becomes reviewer, JUDGE handles signoff. Next 3 turns will produce concrete file changes.", summary: sumNextActionAnnounce })],
  },
  {
    label: "[agent] next_action_phase: implementer (CollapsibleBlock indigo + emerald chip)",
    entries: [entry({ role: "agent", agentIndex: 2, text: "Implementing the split-by-domain refactor. Created src/handlers/routes/users.ts with the user-related handlers extracted from api.ts. Added zod schema for User input validation. Verified the existing tests pass against the new module. Next: orders.ts.", summary: sumNextActionImpl })],
  },
  {
    label: "[agent] next_action_phase: reviewer (CollapsibleBlock indigo + rose chip)",
    entries: [entry({ role: "agent", agentIndex: 3, text: "Reviewing the implementer's commit: the schema looks reasonable but the extracted module re-imports the original userService instead of receiving it as a constructor arg. This will cause a circular import once orders.ts also depends on it. Recommend extracting the dependency as a parameter.", summary: sumNextActionReview })],
  },
  {
    label: "[agent] next_action_phase: signoff (CollapsibleBlock indigo + amber chip)",
    entries: [entry({ role: "agent", agentIndex: 4, text: "Signoff: the reviewer's circular-import concern is valid; the implementer's response (extract dependency as constructor arg) addresses it. Final commit looks good. Approve.", summary: sumNextActionSignoff })],
  },
  {
    label: "[agent] debate_verdict (DebateVerdictBubble - scorecard grid)",
    entries: [entry({ role: "agent", agentIndex: 4, text: JSON.stringify(sumDebateVerdict, null, 2), summary: sumDebateVerdict })],
  },
  {
    label: "[agent] stretch_goals (custom violet card)",
    entries: [entry({ role: "agent", agentIndex: 1, text: JSON.stringify(sumStretchGoals, null, 2), summary: sumStretchGoals })],
  },

  // ─── Client-fallback bubbles (no server summary; client-side parser routes) ───
  {
    label: "[agent client-fallback] contract envelope (ContractBubble - 3 tabs)",
    entries: [entry({ role: "agent", agentIndex: 1, text: contractEnvelope })],
  },
  {
    label: "[agent client-fallback] auditor envelope (AuditorVerdictBubble - 3 tabs)",
    entries: [entry({ role: "agent", agentIndex: 5, text: auditorEnvelope })],
  },
  {
    label: "[agent client-fallback] todos envelope (TodosBubble - 3 tabs, NEW 2026-04-27 evening)",
    entries: [entry({ role: "agent", agentIndex: 1, text: todosEnvelope })],
  },
  {
    label: "[agent client-fallback] worker_hunks loose (no server tag, WorkerHunksBubble via tryParseWorkerHunks)",
    entries: [entry({ role: "agent", agentIndex: 2, text: workerHunksRawJson })],
  },
  {
    label: "[agent client-fallback] generic JSON (JsonPrettyBubble - kind not recognized)",
    entries: [entry({ role: "agent", agentIndex: 1, text: JSON.stringify({ randomShape: { foo: "bar", count: 42, nested: [{ a: 1 }, { b: 2 }] } }, null, 2) })],
  },
  {
    label: "[agent client-fallback] prose with thoughts (Phase 1 ThoughtsBlock above main bubble)",
    entries: [entry({ role: "agent", agentIndex: 1, text: proseTextWithThoughts, thoughts: "Let me think about this carefully. The request is to split a monolithic handler into per-route modules. The trade-offs are: split-by-domain (matches existing folder structure, simpler imports) vs split-by-feature (more flexible long-term but more refactoring work upfront).\n\nGiven the current scale (3 domains), split-by-domain is the right call. The constructor-arg concern is real and needs addressing.\n\nI'll write a clear, concise final response that picks the cleaner option without over-explaining the deliberation." })],
  },
  {
    label: "[agent client-fallback] unpaired </think> closer (RCA preset 1, fixed in #228)",
    // Real shape from run af27f55c entry 14 — model emitted an empty
    // todos array preceded by a leaked </think> with no opening tag.
    // Pre-fix: closer rendered as raw text. Post-fix: prefix becomes a
    // thought, closer consumed.
    entries: [entry({ role: "agent", agentIndex: 1, text: "[]", thoughts: "(would be the mid-stream prefix before the unpaired </think>)" })],
  },
  {
    label: "[agent] tool-call markers extracted (#229 NEW - planner emitted 30+ <read>/<grep>)",
    // Real shape from run af27f55c entry 10 — planner emitted dozens
    // of XML tool-call markers as raw text. Pre-fix: leaked into bubble
    // + caused contract parse failure. Post-fix: stripped server-side,
    // surfaced in collapsed amber ToolCallsBlock above the bubble.
    entries: [entry({
      role: "agent",
      agentIndex: 1,
      text: "After scanning the codebase, the supervisor module needs three call sites updated to use the shared retry helper.",
      toolCalls: [
        "<read path='src/supervisor.ts' start_line='1' end_line='100'>",
        "<read path='src/supervisor.ts' start_line='100' end_line='200'>",
        "<read path='src/supervisor.ts' start_line='200' end_line='300'>",
        "<grep path='src/supervisor.ts' pattern='retry|backoff|maxRetries'>",
        "<list>src/__tests__/</list>",
        "<glob>src/**/*.test.ts</glob>",
      ],
    })],
  },
  {
    label: "[agent client-fallback] segmented prose (segmentSplitPoints - shows collapsed-then-final-segment)",
    entries: [entry({ role: "agent", agentIndex: 2, text: "First segment: setting up the analysis. I want to look at the request handler structure carefully to decide where to make cuts.\n\nSecond segment: scanning src/handlers/api.ts. Found 3 distinct domains: users (4 handlers), orders (5 handlers), sessions (2 handlers). All currently colocated in one 800-LOC file.\n\nThird segment (final): the cleanest split is by domain. I'll create src/handlers/routes/{users,orders,sessions}.ts and have api.ts re-export them as a barrel.", segmentSplitPoints: [121, 354] })],
  },
  {
    label: "[agent client-fallback] plain text (CollapsibleBlock final fallback)",
    entries: [entry({ role: "agent", agentIndex: 4, text: "I've completed the analysis. The next step is to write the per-route modules and verify the existing tests still pass." })],
  },

  // ─── Quota pause/resume ribbons (system entries; NEW 2026-04-27 evening) ───
  {
    label: "[system] quota_paused (amber ribbon, NEW 2026-04-27 evening)",
    entries: [entry({ role: "system", text: "Ollama quota wall hit (503: rate limit). Pausing run; will probe upstream every 5 min and resume when it clears. Total pause cap: 60 min.", summary: sumQuotaPaused })],
  },
  {
    label: "[system] quota_resumed (emerald ribbon, NEW 2026-04-27 evening)",
    entries: [entry({ role: "system", text: "Quota wall cleared after 5.2 min. Resuming planner pump.", summary: sumQuotaResumed })],
  },
];

export function BubbleGallery() {
  return (
    <div className="min-h-full bg-ink-900 text-ink-100 p-6 overflow-y-auto">
      <header className="mb-6 pb-3 border-b border-ink-700">
        <h1 className="text-xl font-semibold tracking-tight">Bubble gallery — validation tour fixture</h1>
        <p className="text-xs text-ink-400 mt-1 font-mono">
          {fixtures.length} fixtures · ?gallery=1 · 2026-04-27 · use for visual audit of each summary.kind variant
        </p>
      </header>
      <div className="space-y-6 max-w-4xl mx-auto">
        {fixtures.map((f) => (
          <section key={f.label} data-fixture-label={f.label} className="border border-ink-700/60 rounded-lg p-4 bg-ink-800/30">
            <h2 className="text-[11px] font-mono uppercase tracking-wide text-ink-400 mb-3 break-all">{f.label}</h2>
            <div className="space-y-2">
              {f.entries.map((e) => (
                <MessageBubble key={e.id} entry={e} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
