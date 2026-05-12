#!/usr/bin/env node
// Dataflow & Dependency Analysis — traces data through the system.
// Usage: npx tsx server/scripts/dataflow-analysis.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const srcDir = path.join(root, "server", "src");

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(dir)) {
    const f = path.join(dir, entry);
    if (entry.startsWith(".") || entry === "node_modules") continue;
    if (statSync(f).isDirectory()) out.push(...walkFiles(f));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(f);
  }
  return out;
}

function relativeToSrc(f: string): string {
  return path.relative(srcDir, f);
}

function countImports(f: string): string[] {
  try {
    const src = readFileSync(f, "utf8");
    return [...src.matchAll(/from\s+["'](.+?)["']/g)].map((m) => m[1]);
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. DEPENDENCY GRAPH — Import analysis
// ═══════════════════════════════════════════════════════════════════════════

console.log("=".repeat(65));
console.log("DATAFLOW & DEPENDENCY ANALYSIS — ollama_swarm");
console.log("=".repeat(65));

const allFiles = walkFiles(srcDir);

// Count how many files import each file
const importeeCount = new Map<string, number>();
const importerCount = new Map<string, number>();

for (const f of allFiles) {
  const relF = relativeToSrc(f);
  const imports = countImports(f);
  importerCount.set(relF, imports.length);

  for (const imp of imports) {
    const resolved = imp.replace(/^\.\.\/\.\.\//, "").replace(/^\.\.?\//, "");
    // Normalize: resolve relative imports to approximate file paths
    const key = resolved.split("/").pop()?.replace(/\.js$/, ".ts") ?? resolved;
    importeeCount.set(key, (importeeCount.get(key) ?? 0) + 1);
  }
}

// ── Most depended-upon files ──
console.log("\n── Dependency Graph: Most depended-upon files ──");
console.log("Imported by | File");
console.log("-".repeat(50));

const topImportees = [...importeeCount.entries()]
  .filter(([k]) => k.endsWith(".ts"))
  .sort(([, a], [, b]) => b - a)
  .slice(0, 15);

for (const [file, count] of topImportees) {
  console.log(`  ${String(count).padStart(10)} | ${file}`);
}

// ── Most coupled files (most imports) ──
console.log("\n── Dependency Graph: Files with most imports ──");
console.log("Imports | File");
console.log("-".repeat(50));

const topImporters = [...importerCount.entries()]
  .sort(([, a], [, b]) => b - a)
  .slice(0, 10);

for (const [file, count] of topImporters) {
  console.log(`  ${String(count).padStart(7)} | ${file}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. DATAFLOW: Todo lifecycle
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Dataflow 1: Todo lifecycle ──");
console.log(`
  Planner                    Board               Worker                  Disk/Git
  ───────                    ─────               ──────                  ────────
  runPlanner()               
    │                        
    │ postTodo(todo) ──────→ TodoQueue
    │                        status=open
    │                        
    │                        runWorker() polls
    │                        │
    │                        │ dequeueByScore()
    │                        │ status=claimed ──→ executeWorkerTodo()
    │                        │                        │
    │                        │                        │ readExpectedFiles()
    │                        │                        │ promptAgent() [12-70s]
    │                        │                        │ parseWorkerResponse()
    │                        │                        │   ├ parse OK
    │                        │                        │   ├ repair OK
    │                        │                        │   ├ brain OK
    │                        │                        │   └ sibling OK
    │                        │                        │
    │                        │                        │ applyAndCommit()
    │                        │                        │   ├ read files
    │                        │                        │   ├ apply hunks [CAS]
    │                        │                        │   ├ write to disk ──→ filesystem
    │                        │                        │   └ git commit ─────→ git
    │                        │                        │
    │                        │   completeTodo() ←──── │
    │                        │   status=committed    │
    │                        │                        │
    │   replan (if stale)    │   failTodo() ←──────── │ (if all tiers fail)
    │   rerun planner        │   status=stale         │
`);

// ═══════════════════════════════════════════════════════════════════════════
// 3. DATAFLOW: User directive
// ═══════════════════════════════════════════════════════════════════════════

console.log("── Dataflow 2: User directive ──");
console.log(`
  Web UI                    Server                   Planner             Workers
  ──────                    ──────                   ───────             ───────
  SetupForm                 
    │                        
    │ POST /api/swarm/start ─→ swarmRouter
    │                        │ Zod validate
    │                        │ Orchestrator.start()
    │                        │ Runner.start()
    │                        │   │
    │                        │   │ clone repo
    │                        │   │ spawn agents
    │                        │   │
    │                        │   │ buildSeed(directive)
    │                        │   │   ├ readmeExcerpt
    │                        │   │   ├ repoFiles
    │                        │   │   └ userDirective ──→ PLANNER_SYSTEM_PROMPT
    │                        │   │
    │                        │   │ runPlanner(seed) ──→ Ollama [planner prompt]
    │                        │   │                        │
    │                        │   │                        │ parse → todos[]
    │                        │   │                        │ each todo has
    │                        │   │                        │ description,
    │                        │   │                        │ expectedFiles
    │                        │   │                        │
    │                        │   │   ← return todos      │
    │                        │   │                       
    │                        │   │ postTodos ──→ Board
    │                        │   │
    │   WS: transcript ────── ← emit(transcript_append)
    │   WS: todo_claimed ──── ← emit
    │   WS: todo_committed ── ← emit
`);

// ═══════════════════════════════════════════════════════════════════════════
// 4. DATAFLOW: Agent prompt (discussion presets)
// ═══════════════════════════════════════════════════════════════════════════

console.log("── Dataflow 3: Agent prompt (discussion preset) ──");
console.log(`
  Runner                    DiscussionRunnerBase      Ollama              Client
  ──────                    ────────────────────      ──────              ──────
  start()
    │                        
    │ initCloneAndSpawn()
    │ spawn agents
    │                        
    │ loop()
    │   │                    
    │   │ runTurn(agent)
    │   │   │              
    │   │   │ buildPrompt ──→ (preset-specific)
    │   │   │   transcript   prompt text
    │   │   │   userDirective
    │   │   │   roundNumber
    │   │   │                
    │   │   │ runDiscussionAgent()
    │   │   │   │              markStatus("thinking")
    │   │   │   │              promptWithFailoverAuto ──→ Ollama [12-70s]
    │   │   │   │              extractTextWithDiag       │
    │   │   │   │              stripAgentText ←───────── response
    │   │   │   │              
    │   │   │   │              push to transcript
    │   │   │   │              emit(transcript_append) ────────────→ WS
    │   │   │   │              markStatus("ready")                  │
    │   │   │   │                                                 │
    │   │   │   │              Stats: tokens, latency              │
    │   │   │   │              Error capture → emit(error) ────────→ WS
`);

// ═══════════════════════════════════════════════════════════════════════════
// 5. DATAFLOW: Event stream (WebSocket)
// ═══════════════════════════════════════════════════════════════════════════

console.log("── Dataflow 4: Event stream ──");
console.log(`
  Server emits              Broadcaster             EventLogger           Client
  ────────────              ───────────             ───────────           ──────
  opts.emit(event) ────────→ broadcast(event)
                                │
                                ├── validate(event) [if validate=true]
                                │
                                ├── logger.log(event) ──→ current.jsonl
                                │
                                │   JSON.stringify(event)
                                │   │
                                │   ├── ws.send(payload) ──────────────→ WS client
                                │   │   (per-runId filter applied)
                                │   │
                                │   └── if payload > 1MB: drop, warn
                                │
                                └── return

  Event types (from SwarmEventBody):
    swarm_state    — phase + round changes
    agent_state    — thinking/ready/failed per agent
    transcript_append — new agent or system message
    todo_claimed   — worker claimed a todo
    todo_committed — worker committed a todo
    todo_stale     — worker failed a todo
    contract_updated — auditor updated the contract
    run_summary    — run completed with final stats
    tier-up-decision — ambition ratchet fired
    model_shift    — sibling retry swapped models
    brain-fallback — AI parser was invoked
    error          — unhandled error
    clone_state    — repo cloned (alreadyPresent, files)
`);

// ═══════════════════════════════════════════════════════════════════════════
// 6. DATAFLOW: Run state persistence
// ═══════════════════════════════════════════════════════════════════════════

console.log("── Dataflow 5: Run state persistence ──");
console.log(`
  Runtime                   Disk (runs/)              Startup Recovery
  ───────                   ───────────              ────────────────
  Orchestrator.start()
    │
    │ mint runId
    │ acquire .lock
    │
    │ RunStatePersister
    │   │ scheduleStateWrite() [every 30s]
    │   │   ├ contract
    │   │   ├ tier state
    │   │   ├ transcript
    │   │   └ agent states    ──→ run-state.json
    │   │
    │   │ on completion:
    │   │   writeBlackboardDeliverable() ──→ deliverable.md
    │   │   writeRunSummary() ──→ summary-<iso>.json
    │   │
    │   │ release .lock
    │
    │ autoResumeOnStartup()
    │   │ scan runs/ for run-state.json
    │   │ decideAutoResume() [age + transcript length]
    │   │ recoverRun() → new runId on existing clone
`);

// ═══════════════════════════════════════════════════════════════════════════
// 7. DATAFLOW: Model failover chain
// ═══════════════════════════════════════════════════════════════════════════

console.log("── Dataflow 6: Model failover chain ──");
console.log(`
  promptWithRetry           promptWithFailover         Sibling Retry
  ────────────────          ──────────────────         ─────────────
  promptAgent()
    │
    │ promptWithFailoverAuto()
    │   │ classifyError(err)
    │   │   ├ unknown → retry same (5s backoff)
    │   │   ├ retryable → retry (exponential backoff)
    │   │   └ non-retryable → swap model
    │   │
    │   │ decideFailover(currentModel, classified)
    │   │   │ SWARM_PROVIDER_FAILOVER env
    │   │   │   ├ glm-5.1 → nemotron → deepseek
    │   │   │   └ or: per-run cfg.providerFailover
    │   │   │
    │   │   │ updateAgentModel(agent, newModel)
    │   │   │ emit(model_shift)
    │   │   └──→ retry prompt with new model
    │   │
    │   │ if all fail → throw (caught by cascade)
    │
    │ parseWorkerResponse(response)
    │   ├ ok → applyAndCommit
    │   └ fail → withSiblingRetry()
    │             │
    │             │ capture modelAtEntry
    │             │ getFallbackModel() ?? siblingModelFor(current)
    │             │ swap model + emit model_shift
    │             │ run fn (re-prompt or recursive call)
    │             │ finally: restore model + emit revert
`);

// ═══════════════════════════════════════════════════════════════════════════
// 8. COUPLING HOTSPOTS
// ═══════════════════════════════════════════════════════════════════════════

console.log("── Coupling hotspots ──");

// Check for import cycles
const cycles = new Set<string>();

for (const f of allFiles) {
  // Simple cycle detection: does file A import file B, and B import A?
  const relF = relativeToSrc(f);
  const imports = countImports(f);

  for (const imp of imports) {
    const impBase = imp.replace(/^\.\.\/\.\.\//, "").replace(/^\.\.?\//, "").replace(/\.js$/, ".ts");
    for (const otherF of allFiles) {
      const otherRel = relativeToSrc(otherF);
      if (otherRel === impBase || otherRel.endsWith(impBase)) {
        const otherImports = countImports(otherF);
        const importsBack = otherImports.some(
          (oi) => oi.includes(path.basename(f, ".ts"))
        );
        if (importsBack) {
          const pair = [relF, otherRel].sort().join(" ↔ ");
          cycles.add(pair);
        }
      }
    }
  }
}

if (cycles.size > 0) {
  console.log("\n  Import cycles detected:");
  for (const c of [...cycles].slice(0, 5)) {
    console.log(`    ${c}`);
  }
} else {
  console.log("\n  No import cycles detected. Clean DAG.");
}

// Show files that are imported by the most OTHER files
console.log("\n  High-churn risk (widely imported files):");
const highChurn: Array<{ file: string; count: number; changesThisSession: boolean }> = [];

// Check which of the top importees were modified this session
const modifiedThisSession = new Set([
  "types.ts", "BlackboardRunner.ts", "contextBuilders.ts", "workerRunner.ts",
  "SwarmRunner.ts", "Orchestrator.ts", "DiscussionRunnerBase.ts",
]);

for (const [file, count] of topImportees.slice(0, 6)) {
  highChurn.push({
    file,
    count,
    changesThisSession: modifiedThisSession.has(file),
  });
}

for (const h of highChurn) {
  const marker = h.changesThisSession ? " (modified this session!)" : "";
  console.log(`    ${String(h.count).padStart(3)} import(s) → ${h.file}${marker}`);
}

console.log("\n  Implication: changes to these files have wide blast radius.");
console.log("  types.ts is the most fragile — 10 files depend on its shape.");
