#!/usr/bin/env node
// Strategic Recommendations — synthesized from all analyses.
// Usage: npx tsx server/scripts/recommendations.ts

console.log("=".repeat(62));
console.log("STRATEGIC RECOMMENDATIONS — ollama_swarm");
console.log("=".repeat(62));

const recs = [
  {
    priority: 1,
    title: "Make the eval catalog your competitive moat",
    why: "The Monte Carlo simulation proved hunk quality is the #1 throughput lever. The LCCA proved model drift is the #1 lifecycle cost. The eval catalog directly addresses both — it catches model drift BEFORE production runs stall, and it quantifies hunk quality regression across model updates.",
    what: [
      "Add 1-2 eval tasks for each uncovered preset (ow-deep is the only gap at 91% coverage)",
      "Run the eval catalog on EVERY model update, not just weekly CI",
      "Publish eval results as a scoreboard — this is how OTHERS will judge model quality for swarm workloads",
      "Add 'hunk quality' as a scored dimension in the eval catalog (currently not tracked)",
    ],
    source: "Monte Carlo + LCCA + Quality audit",
  },
  {
    priority: 1,
    title: "Model drift early-warning system",
    why: "Maintenance is 81% of 3-year lifecycle cost. Model drift remediation alone is 8 hours/month. The drift-check script exists but runs manually. A model behavior change that breaks 3 parsers is currently discovered in production.",
    what: [
      "Wire drift-check.ts into a pre-start hook — before `Orchestrator.start()`, validate that all 7 prompts pass their registry assertions against the current model",
      "Log drift warnings as `brain-fallback` events so post-run analysis can correlate staleness with model changes",
      "Add a 'prompt version' field to RunSummary — if a run used prompt v1 and a newer run uses v2, the eval catalog should flag the delta",
    ],
    source: "LCCA risk model + Prompt registry",
  },
  {
    priority: 2,
    title: "Open-weights local-first is the strategic bet",
    why: "Cloud is cheap today but vulnerable to inflation (10%/yr, LCCA-proven). Local Ollama latency (12x faster on gemma4, 14x on glm-5.1) is the single biggest performance lever across ALL analyses. The project's stated value prop is 'open-weights multi-agent parallelism' — the local-first path directly reinforces this.",
    what: [
      "Add a `--local` mode to the web UI (not just the eval script) that strips `:cloud` and routes through local Ollama",
      "Benchmark real local Ollama latency (the 12x estimate is from model-behaviors.md, needs empirical validation)",
      "Document the local setup: model pulling (`ollama pull glm-5.1`), GPU requirements, RAM sizing",
      "Add a 'latency' column to the run summary that shows per-model turn times (cloud vs local comparison)",
    ],
    source: "Performance v2 + LCCA + Monte Carlo",
  },
  {
    priority: 2,
    title: "Tier-ratchet ambition is under-tested in production",
    why: "The blackboard tier ratchet (tier 1→2→3 ambition climb) is the system's most unique feature — no other multi-agent framework has self-directed ambition. But it's only been tested in controlled eval runs, not in open-ended production scenarios. The formal methods analysis confirmed the state machine is correct, but the planner's behavior at tier 2+ (where it needs repo awareness) is unvalidated.",
    what: [
      "Add a 'tier' field to RunSummary that shows which tier each commit came from",
      "Run a dedicated eval sweep that tests tier-2 ambition on real-world repos",
      "Add a 'tier-up' event to the SwarmEvent stream so the UI can show when the ratchet fires",
      "Document the expected tier-2 behavior: 'planner should generate more ambitious criteria that span multiple files'",
    ],
    source: "Statechart analysis + Formal methods",
  },
  {
    priority: 3,
    title: "Multi-user readiness assessment",
    why: "The system is architected for multi-tenant (per-run WS filter, per-run REST routes, concurrency cap), but everything beyond that is single-user. The LCCA showed development cost is 19% of lifecycle — adding multi-user features now costs a fraction of what it would after deployment.",
    what: [
      "WS authentication is shipped (cookie token). Next: per-user run isolation (user A can't see user B's runs)",
      "Add a 'run ownership' concept — each run is tagged with a `createdBy` field (defaults to 'kevin' for now)",
      "Add a `/api/swarm/my-runs` endpoint that filters by ownership",
      "Rate-limiting is currently global. Per-user rate limits would prevent one user from DoS'ing others",
    ],
    source: "MoSCoW analysis (all MUST items shipped)",
  },
  {
    priority: 3,
    title: "Document the cascade as a system property",
    why: "The 4-tier parse cascade (parse→repair→brain→sibling) is the system's most sophisticated reliability mechanism. The Monte Carlo proved it's well-tuned with diminishing returns at each tier. The formal methods proved it always terminates. But no documentation explains WHY a 4-tier cascade exists or how to tune it.",
    what: [
      "Add a 'Cascade architecture' section to ARCHITECTURE.md explaining the design rationale",
      "Document the sibling model mapping (glm↔nemotron, deepseek→nemotron) and why it's asymmetric",
      "Add a run-completion diagnostic: 'Tier breakdown: 75% parse, 15% repair, 3% brain, 1% sibling'",
      "If a model change causes a cascade tier to spike (e.g., parse drops from 75%→60%), surface a warning",
    ],
    source: "Monte Carlo + Formal methods + Statechart",
  },
];

let totalEffortDays = 0;

for (const r of recs) {
  const stars = "★".repeat(4 - r.priority + 1);
  console.log(`\n${stars} Priority ${r.priority}: ${r.title}`);
  console.log(`  Source: ${r.source}`);
  console.log();
  console.log(`  Why: ${r.why}`);
  console.log();
  console.log("  What:");
  for (const item of r.what) {
    console.log(`    • ${item}`);
  }

  // Estimate effort
  const effortPerItem = r.priority === 1 ? 0.5 : r.priority === 2 ? 0.3 : 0.2;
  const days = Math.round(r.what.length * effortPerItem * 10) / 10;
  totalEffortDays += days;
  console.log(`\n  Estimated: ~${days} days`);
}

console.log("\n" + "=".repeat(62));
console.log(`Total: ~${Math.round(totalEffortDays)} days across ${recs.length} recommendations`);
console.log("");
console.log("Execution order: Priority 1 items first (they compound).");
console.log("Priority 2 items when eval catalog is stable.");
console.log("Priority 3 items when the system has >1 user.");
