/**
 * Machine-readable control surface for Brain-OS / external agents.
 * Documents start → during → after APIs without requiring OpenAPI.
 */

export interface ControlSurfaceEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  phase: "start" | "during" | "after" | "meta";
  purpose: string;
  bodyHints?: string[];
}

export const BRAIN_CONTROL_SURFACE = {
  version: 1,
  title: "ollama_swarm Brain-OS control surface",
  notes: [
    "All paths are relative to the server origin (default http://127.0.0.1:8243).",
    "Prefer /runs/:runId/* over legacy unscoped routes when multiple runs are active.",
    "CLI: ollama-swarm <cmd> mirrors these endpoints (see bin/ollama-swarm.mjs).",
  ],
  endpoints: [
    // Start
    {
      method: "POST",
      path: "/api/swarm/start",
      phase: "start",
      purpose: "Start a new swarm run; returns { runId, navigateTo }",
      bodyHints: [
        "parentPath",
        "repoUrl?",
        "userDirective?",
        "preset",
        "agentCount",
        "rounds|continuous",
        "model|plannerModel|workerModel",
        "webTools?|plannerTools?",
        "topology?",
        "wallClockCapMs?",
        "tokenBudget?",
        "writeMode?",
      ],
    },
    {
      method: "GET",
      path: "/api/swarm/outcome/recommend?directive=",
      phase: "start",
      purpose: "Data-backed preset recommendation for a directive",
    },
    {
      method: "POST",
      path: "/api/swarm/brain/chat",
      phase: "start",
      purpose: "Conversational Brain help; structured:true → recommendation+config",
      bodyHints: ["message", "structured?", "runContext?", "explain?"],
    },
    {
      method: "POST",
      path: "/api/swarm/brain/provision",
      phase: "start",
      purpose: "Approve-to-provision a follow-up run from a Brain proposal",
      bodyHints: ["clonePath", "approved:true", "proposalId?|title|description"],
    },
    {
      method: "GET",
      path: "/api/swarm/preflight",
      phase: "start",
      purpose: "Disk/clone preflight for parentPath + repoUrl",
    },
    // During
    {
      method: "GET",
      path: "/api/swarm/runs/:runId/status",
      phase: "during",
      purpose: "Live status snapshot (phase, agents, board, transcript, runStateV2)",
    },
    {
      method: "POST",
      path: "/api/swarm/amend",
      phase: "during",
      purpose: "Mid-run directive addendum (HITL / Brain steer)",
      bodyHints: ["runId", "text (max 1000)"],
    },
    {
      method: "POST",
      path: "/api/swarm/reconfig",
      phase: "during",
      purpose: "Extend rounds / wall-clock / token budget / think-guard referee",
      bodyHints: [
        "runId",
        "extendRounds?|rounds?",
        "extendWallClockCapMin?|wallClockCapMin?",
        "extendTokenBudget?|tokenBudget?",
        "thinkGuardReferee*",
      ],
    },
    {
      method: "POST",
      path: "/api/swarm/say",
      phase: "during",
      purpose: "Inject user/Brain message into transcript (steer|suggest|ask)",
      bodyHints: ["runId", "text", "intent?", "targetAgent?"],
    },
    {
      method: "POST",
      path: "/api/swarm/runs/:runId/say",
      phase: "during",
      purpose: "Per-run scoped say",
    },
    {
      method: "POST",
      path: "/api/swarm/brain/suggest",
      phase: "during",
      purpose: "Inject a Brain suggestion bubble into the live transcript",
      bodyHints: ["runId", "title", "text", "category?"],
    },
    {
      method: "POST",
      path: "/api/swarm/drain",
      phase: "during",
      purpose: "Soft-stop: finish current claims then close out",
      bodyHints: ["runId?"],
    },
    {
      method: "POST",
      path: "/api/swarm/runs/:runId/drain",
      phase: "during",
      purpose: "Per-run soft drain (multi-tenant; same modes as /drain)",
    },
    {
      method: "POST",
      path: "/api/swarm/stop",
      phase: "during",
      purpose: "Hard stop (or drain-then-kill if SWARM_DRAIN_ON_STOP)",
      bodyHints: ["runId?"],
    },
    {
      method: "POST",
      path: "/api/swarm/runs/:runId/stop",
      phase: "during",
      purpose: "Per-run stop (same SWARM_DRAIN_ON_STOP policy as /stop)",
    },
    {
      method: "GET",
      path: "/api/usage?runId=",
      phase: "during",
      purpose: "Token usage + quota wall state for steering cost",
    },
    // After
    {
      method: "GET",
      path: "/api/swarm/run-summary",
      phase: "after",
      purpose: "Load summary.json for a finished run (clonePath + runId)",
    },
    {
      method: "GET",
      path: "/api/swarm/runs",
      phase: "after",
      purpose: "List known runs / digests",
    },
    {
      method: "GET",
      path: "/api/v2/event-log/runs/:runId",
      phase: "after",
      purpose: "Full event log for postmortem / Brain analysis",
    },
    {
      method: "GET",
      path: "/api/swarm/brain/proposals",
      phase: "after",
      purpose: "Pending Brain insights / follow-up proposals",
    },
    {
      method: "GET",
      path: "/api/swarm/brain/activity",
      phase: "after",
      purpose: "Recent Brain activity timeline",
    },
    {
      method: "GET",
      path: "/api/swarm/memory",
      phase: "after",
      purpose: "Cross-run memory store for a clone",
    },
    {
      method: "GET",
      path: "/api/swarm/project-graph",
      phase: "after",
      purpose: "Project growth / knowledge graph for a clone",
    },
    // Meta
    {
      method: "GET",
      path: "/api/swarm/brain/control-surface",
      phase: "meta",
      purpose: "This document (machine-readable)",
    },
    {
      method: "GET",
      path: "/api/swarm/maintenance/status",
      phase: "meta",
      purpose: "App log/run pressure; pass ?clonePath= for target-repo project logs status",
    },
    {
      method: "POST",
      path: "/api/swarm/maintenance/prune",
      phase: "meta",
      purpose: "Prune/purge app logs/runs or project clone logs (default dry-run)",
      bodyHints: [
        "target?: logs|runs|all|project-logs (default logs)",
        "clonePath?: required for project-logs",
        "mode?: prune|purge",
        "apply?: boolean (default false)",
        "keepDays?: number",
        "maxKeep?: number",
        "keepNArchives?: number",
      ],
    },
    {
      method: "GET",
      path: "/api/health",
      phase: "meta",
      purpose: "Liveness",
    },
    {
      method: "GET",
      path: "/api/providers",
      phase: "meta",
      purpose: "Provider availability for model selection",
    },
  ] satisfies ControlSurfaceEndpoint[],
  cli: {
    start: "ollama-swarm start --directive ... --preset ...",
    status: "ollama-swarm status --run-id <id>",
    amend: "ollama-swarm amend --run-id <id> --text ...",
    reconfig: "ollama-swarm reconfig --run-id <id> --extend-wall-clock-min 15",
    say: "ollama-swarm say --run-id <id> --text ... [--intent steer]",
    drain: "ollama-swarm drain --run-id <id>",
    stop: "ollama-swarm stop --run-id <id>",
    list: "ollama-swarm list",
    summary: "ollama-swarm summary --run-id <id> --clone-path ...",
    recommend: "ollama-swarm recommend --directive ...",
    controlSurface: "ollama-swarm control-surface",
    pruneLogs:
      "ollama-swarm prune-logs [--apply] [--target logs|runs|all|project-logs] [--clone-path ...] [--mode prune|purge]",
  },
} as const;
