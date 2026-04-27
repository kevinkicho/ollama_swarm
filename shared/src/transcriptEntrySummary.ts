// V2 Step 2b: shared discriminated union for structured transcript
// summaries. Previously mirrored in server/src/types.ts AND
// web/src/types.ts with a "keep in sync" comment that occasionally
// drifted. Now both sides import from here.
//
// Each variant tags a particular envelope shape that runners parse
// server-side and attach to the transcript entry. Web bubbles dispatch
// rendering by `kind`. Adding a new envelope: add the variant here +
// the server-side tagger (per-runner) + the web-side bubble branch.

export type TranscriptEntrySummary =
  | {
      kind: "worker_hunks";
      hunkCount: number;
      // Per-op breakdown so the UI can show "2 replace, 1 append".
      ops: { replace: number; create: number; append: number };
      // First file touched. Workers are bound to ≤2 expectedFiles
      // and almost always touch one file, so showing the first is
      // the useful cue. Absent on empty-hunks (which would be a skip).
      firstFile?: string;
      // True when the worker spans multiple distinct files.
      multipleFiles: boolean;
      totalChars: number;
    }
  | {
      kind: "worker_skip";
      reason: string;
    }
  // Task #43: orchestrator-worker lead's assignments envelope. Parsed
  // server-side by OrchestratorWorkerRunner after extractText; attached
  // to the transcript entry so the UI renders a glance line + click-to-
  // expand bullet list instead of a wall of JSON.
  | {
      kind: "ow_assignments";
      subtaskCount: number;
      assignments: Array<{ agentIndex: number; subtask: string }>;
    }
  // Phase 2b: council draft/reveal metadata. Tagged on every council
  // transcript entry so the DraftMatrix client component can bucket
  // entries into a 2D grid (round × agent) without fragile indexing.
  // Round 1 = "draft" (peer-hidden). Round 2+ = "reveal" (all drafts
  // visible).
  | {
      kind: "council_draft";
      round: number;
      phase: "draft" | "reveal";
    }
  // Phase 2c: debate-judge per-turn role. Tagged on every debate-
  // judge transcript entry so the VerdictPanel can group PRO/CON
  // argument pairs by round and render the JUDGE verdict separately.
  | {
      kind: "debate_turn";
      round: number;
      role: "pro" | "con" | "judge";
    }
  // Task #79 (2026-04-25): final-consensus synthesis at the end of a
  // council run. Agent-1 produces a single consolidated answer
  // (consensus / disagreements / next-action) integrating every
  // drafter's final position. Web renders distinctively.
  | {
      kind: "council_synthesis";
      rounds: number;
    }
  // Task #80 (2026-04-25): stigmergy report-out at end of run.
  // Agent-1 takes the ranked pheromone table and produces a
  // top-findings + coverage + next-action narrative.
  | {
      kind: "stigmergy_report";
      filesRanked: number;
    }
  // Task #100 (2026-04-25): role-diff synthesis (closes the missing-
  // synthesis gap noted in the 5-preset tour). Agent-1 takes every
  // role's findings and produces a cross-role consolidation. Doubles
  // as the convergence detector for early-stop.
  | {
      kind: "role_diff_synthesis";
      rounds: number;
      roles: number;
    }
  // Task #102 (2026-04-25): post-verdict build phase for debate-judge.
  // After a high/medium-confidence non-tie verdict, PRO becomes
  // implementer (file-edits), CON reviewer, JUDGE signoff. The
  // announcement entry uses role="announcement" (system); the agent
  // turns use implementer | reviewer | signoff.
  | {
      kind: "next_action_phase";
      role: "announcement" | "implementer" | "reviewer" | "signoff";
    }
  // Task #81 (2026-04-25): structured debate verdict. JUDGE produces
  // a JSON envelope; runner parses + tags with this kind so the
  // modal renders a scorecard instead of freeform text.
  | {
      kind: "debate_verdict";
      round: number;
      winner: "pro" | "con" | "tie";
      confidence: "low" | "medium" | "high";
      proStrongest: string;
      conStrongest: string;
      proWeakest: string;
      conWeakest: string;
      decisive: string;
      nextAction: string;
    }
  // Task #82 (2026-04-25): final-cycle map-reduce synthesis. Reducer's
  // last cycle output gets tagged so the modal renders it as the
  // run's "answer", separate from intermediate reductions above.
  | {
      kind: "mapreduce_synthesis";
      cycle: number;
    }
  // Task #72 (2026-04-25): structured payload for the end-of-run
  // banner. The transcript text is still human-readable, but the
  // grid renderer uses these fields directly so it can lay out a
  // table without parsing back the formatted text. Per-agent stats
  // mirror PerAgentStat (subset — only what the grid renders).
  | {
      kind: "run_finished";
      // Identity / context
      runId?: string;
      preset: string;
      model: string;
      repoUrl: string;
      clonePath: string;
      // Timing
      startedAt: number;
      endedAt: number;
      wallClockMs: number;
      // Outcome
      stopReason: string;
      stopDetail?: string;
      filesChanged: number;
      commits?: number;
      totalTodos?: number;
      skippedTodos?: number;
      staleEvents?: number;
      linesAdded: number;
      linesRemoved: number;
      // Task #163: run-level token totals (accurate, computed from
      // tokenTracker.recent filtered by run window).
      totalPromptTokens?: number;
      totalResponseTokens?: number;
      agents: Array<{
        agentIndex: number;
        role: string;
        turns: number;
        attempts: number;
        retries: number;
        meanLatencyMs: number | null;
        commits: number;
        linesAdded: number;
        linesRemoved: number;
        rejected: number;
        jsonRepairs: number;
        promptErrors: number;
        // Task #163: per-agent token totals. Approximate for parallel
        // runners (council/OW/MR all fire concurrent calls); accurate
        // for sequential runners (round-robin/stigmergy/debate-judge/
        // blackboard-planner-only paths). Null when no tokens recorded
        // for this agent.
        tokensIn?: number | null;
        tokensOut?: number | null;
      }>;
    }
  // Task #72: structured seed-announce. Renders as a definition list
  // (repo / clone path) plus a collapsible top-level entries grid so
  // the wall-of-text Top-level entries: ... line is no longer the only
  // way to see this data.
  | {
      kind: "seed_announce";
      repoUrl: string;
      clonePath: string;
      topLevel: string[];
    }
  // Task #129: stretch-goal reflection (post-completion). Planner is
  // asked one meta-question after a successful run: "what would the
  // BEST version of this work have done?". The parsed list of
  // goals (1-5 entries) ships with the entry so the UI can render
  // them as a discrete card and the next run can pick one as a
  // userDirective. Blackboard-only.
  | {
      kind: "stretch_goals";
      goals: string[];
      tier: number;
      committed: number;
    }
  // Task #151: verifier verdict (#128). When the per-commit verifier
  // gate fires, we emit a system message with this structured tag so
  // the UI can render a colored ribbon (green/amber/red/gray)
  // alongside the citation, instead of letting the verdict get buried
  // in plain system noise. Blackboard-only.
  | {
      kind: "verifier_verdict";
      verdict: "verified" | "partial" | "false" | "unverifiable";
      proposingAgentId: string;
      todoDescription: string;
      evidenceCitation: string;
      rationale?: string;
    }
  // Task #165: blackboard pause/resume on Ollama-quota wall.
  // Emitted at pause-entry + resume so the UI can render a "paused,
  // probing every 5min" ribbon and history of pause/resume events.
  | {
      kind: "quota_paused";
      statusCode?: number;
      reason?: string;
    }
  | {
      kind: "quota_resumed";
      pausedMs: number;
      totalPausedMs: number;
    }
  // 2026-04-27: structured "agents ready" payload. Replaces the bare
  // "N/M agents ready on ports X, Y, Z" system text with an expandable
  // grid showing per-agent details (port, role, sessionId, model,
  // warmupMs). Lets users RCA spawn issues like the cold-start empty-
  // response chain (warmup_ok → stale session.idle → empty) without
  // hunting through the diag log.
  | {
      kind: "agents_ready";
      preset: string;
      readyCount: number;
      requestedCount: number;
      spawnElapsedMs: number;
      agents: Array<{
        id: string;
        index: number;
        port: number;
        model: string;
        sessionId: string;
        /** Free-form role label per preset: "Planner", "Worker", "Auditor",
         *  "Lead", "Drafter", "Reducer", "Mapper", "Pro", "Con", "Judge", etc. */
        role: string;
        /** Warmup elapsedMs from AgentManager. Undefined when the runner
         *  spawned with skipWarmup OR the warmup result wasn't recorded. */
        warmupMs?: number;
      }>;
    };
