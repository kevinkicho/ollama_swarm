// #89 (2026-05-01): SWE-Bench Lite adapter.
//
// Converts a SWE-Bench task row into the catalog-entry shape that
// eval/run-eval.mjs already understands. Pure function — no I/O,
// no network, no git. The harness handles cloning + test execution
// in a separate phase.
//
// Why pure: the eval harness already has fixture-mode (#319 + Phase 7
// of #314); we don't need to reinvent the staging / cloning / verify
// loop. We just need a translator from "SWE-Bench JSON" → "the catalog
// entry shape that triggers fixture-mode."
//
// One caveat: SWE-Bench tasks reference REMOTE github repos at specific
// commits, while our existing fixture-mode expects a LOCAL fixture
// directory. The adapter classifies each task as either:
//   - "fixture-shape" (we'll need to clone + checkout, future iteration)
//   - "env-incompatible" (some tasks need pip-installed numpy / scipy
//     / etc. that won't be in our Node-only env — skipped with a clear
//     verdict so the sweep doesn't choke)

/**
 * @typedef {Object} SweBenchTask
 * @property {string} instance_id
 * @property {string} repo                  e.g. "astropy/astropy"
 * @property {string} base_commit
 * @property {string} problem_statement     the GitHub issue text
 * @property {string} patch                 the gold patch (for scoring)
 * @property {string} test_patch            how to verify (for scoring)
 * @property {string} [hints_text]          optional issue comments
 * @property {string} [environment_setup_commit] optional commit to set up env
 * @property {string} [version]             upstream version tag at the time
 */

/**
 * @typedef {Object} CatalogEntry
 * @property {string} id                    catalog id (matches --only / --task-id)
 * @property {string} title                 short human-readable title
 * @property {string} directive             userDirective passed to the swarm
 * @property {string[]} presets             which presets the task supports
 * @property {number} rounds
 * @property {number} agentCount
 * @property {number} wallClockCapMs
 * @property {boolean} expectFilesChanged
 * @property {string} sweBenchInstanceId    so the runner can hook test-patch verify
 * @property {string} repo
 * @property {string} baseCommit
 * @property {string} [skipReason]          set when env-incompatible
 */

// Heuristic — Python repos with native deps (numpy, scipy, scikit, etc.)
// can't run their test suites in our Node-only local env. The official
// SWE-Bench harness uses Docker images with all deps preinstalled.
// Until we wire Docker-based execution, classify these as
// "env-incompatible" so the sweep records them as skipped instead of
// failed.
const ENV_INCOMPATIBLE_REPOS = new Set([
  "scikit-learn/scikit-learn",
  "matplotlib/matplotlib",
  "scipy/scipy",
  "numpy/numpy",
  "pandas-dev/pandas",
  "astropy/astropy",
  "sympy/sympy",
  "pylint-dev/pylint",
  "psf/requests",
  "pydicom/pydicom",
  "pytest-dev/pytest",
  "django/django",
  "pyvista/pyvista",
  "sphinx-doc/sphinx",
  "mwaskom/seaborn",
  "marshmallow-code/marshmallow",
  "pvlib/pvlib-python",
  "pydata/xarray",
]);

// Default per-task budgets. SWE-Bench tasks vary widely in complexity;
// these are starting points the user can override per-sweep via
// presets[].rounds / agentCount on the catalog row.
const DEFAULTS = {
  presets: ["blackboard"],
  rounds: 5,
  agentCount: 4,
  wallClockCapMs: 15 * 60 * 1000, // 15min — half of the official harness cap
};

/**
 * Convert a SWE-Bench task row into a catalog entry.
 *
 * @param {SweBenchTask} task
 * @param {Object} [overrides]  Per-task overrides for presets / rounds / etc.
 * @returns {CatalogEntry}
 */
export function adaptSweBenchTask(task, overrides = {}) {
  if (!task || typeof task !== "object") {
    throw new Error("adaptSweBenchTask: task must be a SweBenchTask object");
  }
  for (const required of ["instance_id", "repo", "base_commit", "problem_statement"]) {
    if (typeof task[required] !== "string" || task[required].length === 0) {
      throw new Error(`adaptSweBenchTask: missing required field '${required}'`);
    }
  }

  const isEnvIncompatible = ENV_INCOMPATIBLE_REPOS.has(task.repo);
  const directive = buildDirective(task);
  const entry = {
    id: `swe-bench:${task.instance_id}`,
    title: titleFromInstanceId(task.instance_id),
    directive,
    presets: overrides.presets ?? DEFAULTS.presets,
    rounds: overrides.rounds ?? DEFAULTS.rounds,
    agentCount: overrides.agentCount ?? DEFAULTS.agentCount,
    wallClockCapMs: overrides.wallClockCapMs ?? DEFAULTS.wallClockCapMs,
    expectFilesChanged: true,
    sweBenchInstanceId: task.instance_id,
    repo: task.repo,
    baseCommit: task.base_commit,
  };
  if (isEnvIncompatible) {
    entry.skipReason = `env-incompatible: ${task.repo} requires Python deps not available in our Node-only local env. Wire Docker-based execution to enable.`;
  }
  return entry;
}

/**
 * Adapt every task in a SWE-Bench JSONL stream. Bad rows are returned
 * with `error` set so the caller can surface them rather than aborting
 * the whole sweep.
 *
 * @param {string} jsonlText  The full text of a SWE-Bench JSONL file.
 * @param {Object} [opts]
 * @param {number} [opts.limit]  If set, only the first N rows.
 * @returns {{ entries: CatalogEntry[], errors: Array<{line: number; reason: string}> }}
 */
export function adaptSweBenchJsonl(jsonlText, opts = {}) {
  const lines = jsonlText.split("\n");
  const entries = [];
  const errors = [];
  let lineNum = 0;
  for (const line of lines) {
    lineNum += 1;
    if (line.trim().length === 0) continue;
    if (typeof opts.limit === "number" && entries.length >= opts.limit) break;
    let task;
    try {
      task = JSON.parse(line);
    } catch (err) {
      errors.push({ line: lineNum, reason: `JSON parse failed: ${err.message}` });
      continue;
    }
    try {
      entries.push(adaptSweBenchTask(task));
    } catch (err) {
      errors.push({ line: lineNum, reason: err.message });
    }
  }
  return { entries, errors };
}

/**
 * Build the userDirective the swarm sees. Combines the issue
 * problem_statement + (optionally) hints. Cap at 4000 chars to fit
 * inside RunConfig.userDirective's existing zod max.
 */
function buildDirective(task) {
  const parts = [];
  parts.push(`SWE-Bench task: ${task.instance_id}`);
  parts.push(`Repository: ${task.repo} @ ${task.base_commit.slice(0, 7)}`);
  parts.push("");
  parts.push("=== Issue ===");
  parts.push(task.problem_statement.trim());
  if (task.hints_text && task.hints_text.trim().length > 0) {
    parts.push("");
    parts.push("=== Hints (from issue comments) ===");
    parts.push(task.hints_text.trim());
  }
  parts.push("");
  parts.push("Resolve the issue. Make the smallest patch that fixes the bug + passes the existing test suite. Do not add unrelated refactors.");
  const directive = parts.join("\n");
  return directive.length > 3900 ? directive.slice(0, 3900) + "\n[...truncated]" : directive;
}

/** "astropy__astropy-12907" → "astropy 12907" — readable in the run-history modal. */
function titleFromInstanceId(instanceId) {
  // Format is "<repo>__<repo>-<issue-number>"; collapse to "<repo> #<num>"
  const match = instanceId.match(/^([^_]+)__\1-(\d+)$/);
  if (match) return `${match[1]} #${match[2]}`;
  return instanceId;
}
