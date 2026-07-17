import { checkBuildCommand } from "./blackboard/buildCommandAllowlist.js";
import type { PostTodoInput } from "./blackboard/TodoQueue.js";

export interface ClassifiedCouncilTodo {
  kind: "hunks" | "build";
  command?: string;
  expectedFiles: readonly string[];
}

const BACKTICK_CMD_RE = /`([^`]+)`/g;

/** Known shell/package runners — backtick bodies must look like these to be "build". */
const SHELL_FIRST_TOKEN =
  /^(npm|npx|yarn|pnpm|bun|bunx|python3?|py|pytest|node|deno|make|task|just|cargo|go|jest|vitest|mocha|eslint|prettier|tsc|tsx|uv|poetry|pip|pipenv|ruff|mypy|cmake|gradle|mvn)$/i;

/** Bare test runners that never create files — must not own "Create … tests" todos. */
export const BARE_TEST_RUNNERS = ["jest", "vitest", "mocha", "pytest"] as const;

/**
 * True when the todo is authoring/editing files (including create-tests prose).
 * Run 2964afe8: "Create Vitest unit tests…" must stay hunks, not `command: vitest`.
 */
export function isFileAuthorIntent(description: string): boolean {
  return /\b(fix|add|update|rewrite|replace|implement|refactor|remove|delete|indent|clean\s*up|patch|create|write|scaffold|generate|author|draft)\b/i.test(
    description,
  );
}

/** True when the user/agent intends to *run* a command, not author files. */
export function isRunExecuteIntent(description: string): boolean {
  return (
    /\b(run|execute|invoke|launch)\b/i.test(description)
    || /\b(npm|npx|yarn|pnpm|bun|bunx)\s+(test|run)\b/i.test(description)
  );
}

/**
 * Description is essentially just the runner (optional flags), e.g. "vitest", "pytest -q".
 * Those are legitimate build todos.
 */
export function isBareRunnerDescription(description: string, runner: string): boolean {
  const re = new RegExp(`^\\s*${runner}\\b(?:\\s+[-\\w./=]+)*\\s*$`, "i");
  return re.test(description.trim());
}

/**
 * True when description is create/author tests (framework name is not a run command).
 * Used by build demotion + audit re-mint filters.
 */
export function isTestAuthorDescription(description: string): boolean {
  const lower = description.toLowerCase();
  const author =
    isFileAuthorIntent(description)
    || /\b(unit\s+tests?|test\s+coverage|test\s+file|__tests__|\.test\.|\.spec\.)\b/i.test(
      description,
    );
  if (!author) return false;
  // "Run vitest after adding unit tests" is still a run — only pure author shapes.
  if (isRunExecuteIntent(description) && !/\b(create|write|scaffold|generate|author|draft)\b/i.test(description)) {
    return false;
  }
  return (
    /\b(vitest|jest|mocha|pytest|unit\s+test|test\s+suite|coverage)\b/i.test(lower)
    || /__tests__|\.test\.|\.spec\./i.test(description)
  );
}

/**
 * True when backtick / extracted text is almost certainly source code or a
 * prose path, not a shell command to execute.
 * (After buildCommandAllowlist went fully open, ANY first token passed —
 * so `with placeholder.container():` became a "build" todo.)
 */
export function looksLikeCodeSnippet(cmd: string): boolean {
  const s = cmd.trim();
  if (!s) return true;
  // Assignments, comparisons, Python/JS syntax
  if (/=/.test(s) && !/^(npm|yarn|pnpm|bun)\s+/.test(s)) return true;
  if (/\(\s*\)\s*:/.test(s)) return true; // with x():
  if (/:\s*$/.test(s) && !/https?:/.test(s)) return true; // trailing colon (python blocks)
  if (/\b(with|def|class|import|from|const|let|var|function|return|if|for|while|async|await)\b/i.test(s)
    && !SHELL_FIRST_TOKEN.test(s.split(/\s+/)[0] ?? "")) {
    return true;
  }
  // Comma-separated unpacking / multi-name expressions
  if (/^\w+\s*,\s*\w+/.test(s)) return true;
  // Path-like without a runner: scripts/foo.py alone is not "run me"
  if (/^[A-Za-z0-9_./\\-]+\.(py|ts|js|tsx|jsx|md|json)$/i.test(s) && !/\s/.test(s)) {
    return true;
  }
  return false;
}

/** True when text is a plausible shell invocation agents should run via bash. */
export function looksLikeShellCommand(cmd: string): boolean {
  const s = cmd.trim();
  if (!s || looksLikeCodeSnippet(s)) return false;
  if (!checkBuildCommand(s).ok) return false;
  const first = s.split(/\s+/)[0] ?? "";
  if (SHELL_FIRST_TOKEN.test(first)) return true;
  // Explicit shell composition still ok when first token is a known runner after cd/env
  if (/^(cd|env|export)\b/i.test(first) && SHELL_FIRST_TOKEN.test(s)) {
    // e.g. cd dist && npm test — allow if a runner appears later
    return true;
  }
  if (/\b(npm|npx|yarn|pnpm|bun|python3?|pytest|make)\b/i.test(s)) return true;
  return false;
}

/**
 * Detect build-style todos from description text (run scripts, pytest, etc.).
 *
 * Semantics (run 2964afe8):
 * - "Create Vitest unit tests for…" → hunks (author files)
 * - "Run vitest" / "Execute `vitest`" / bare "vitest" → build
 * - Edit todos that quote code stay hunks
 */
export function classifyCouncilTodo(
  description: string,
  expectedFiles: readonly string[],
): ClassifiedCouncilTodo {
  const lower = description.toLowerCase();

  const fileAuthorIntent = isFileAuthorIntent(description);
  const runIntent = isRunExecuteIntent(description);

  const hasCodeFiles = expectedFiles.some((f) =>
    /\.(py|ts|tsx|js|jsx|go|rs|java|c|cpp|h|cs|rb|php|md|json|yml|yaml)$/i.test(f),
  );

  // Scan ALL backticks; use the first one that looks like a real shell command.
  // (Old code used only the first backtick — often a Python snippet in edit todos.)
  let backtickBuild: string | undefined;
  for (const m of description.matchAll(BACKTICK_CMD_RE)) {
    const cmd = m[1]!.trim();
    if (looksLikeShellCommand(cmd)) {
      backtickBuild = cmd;
      break;
    }
  }
  // Edit/create todos that merely quote a runner stay on the hunks path unless
  // there is explicit run/execute intent (e.g. "Create tests then run `vitest`").
  if (backtickBuild) {
    const preferHunks = fileAuthorIntent && !runIntent;
    // Also prefer hunks when authoring files that look like test paths even if
    // a runner is quoted as a framework name only.
    const preferHunksTestAuthor =
      isTestAuthorDescription(description) && !runIntent;
    if (!preferHunks && !preferHunksTestAuthor) {
      return { kind: "build", command: backtickBuild, expectedFiles };
    }
    // runIntent + fileAuthor: allow build when primary verb is run
    if (runIntent && !preferHunksTestAuthor) {
      return { kind: "build", command: backtickBuild, expectedFiles };
    }
    if (!fileAuthorIntent && !preferHunksTestAuthor) {
      return { kind: "build", command: backtickBuild, expectedFiles };
    }
  }

  // Pure "Run foo.py" without file-author framing
  const runPy = /\brun\s+([^\s`]+\.py)\b/i.exec(description);
  if (runPy && !fileAuthorIntent) {
    const cmd = `python ${runPy[1]}`;
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }
  // "Run X.py" even with mild edit words if primary verb is run and no path expectedFiles?
  if (runPy && /\brun\s+[^\s`]+\.py\b/i.test(description) && !hasCodeFiles) {
    const cmd = `python ${runPy[1]}`;
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  // pytest / jest / vitest / mocha — only when intent is *run*, not *create tests*
  for (const runner of BARE_TEST_RUNNERS) {
    if (!new RegExp(`\\b${runner}\\b`).test(lower)) continue;
    if (fileAuthorIntent || isTestAuthorDescription(description)) {
      // Author path — hunks
      continue;
    }
    if (!runIntent && !isBareRunnerDescription(description, runner)) {
      // Framework name in prose without run/create → default hunks
      continue;
    }
    const cmd = runner;
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  // Other quality runners (eslint, prettier, tsc) — same gate
  for (const runner of ["eslint", "prettier", "tsc"]) {
    if (!new RegExp(`\\b${runner}\\b`).test(lower)) continue;
    if (fileAuthorIntent) continue;
    if (!runIntent && !isBareRunnerDescription(description, runner)) continue;
    const cmd = runner;
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  const pythonMatch = /\b(?:python3?)\s+(\S+)/i.exec(description);
  if (pythonMatch && !fileAuthorIntent && (runIntent || /\bpython3?\s+\S+/i.test(description))) {
    const cmd = `python ${pythonMatch[1]}`;
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  const pkgRun = /\b(npm|npx|yarn|pnpm|bun|bunx)\s+(\S+(?:\s+\S+)*)/i.exec(description);
  if (pkgRun && /\b(run|test|install)\b/i.test(pkgRun[2]!) && !fileAuthorIntent) {
    const cmd = `${pkgRun[1]} ${pkgRun[2]}`.trim();
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }
  // "Run npm test" with mild author words still build when run is primary
  if (pkgRun && runIntent && /\b(run|test|install)\b/i.test(pkgRun[2]!)) {
    const cmd = `${pkgRun[1]} ${pkgRun[2]}`.trim();
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  return { kind: "hunks", expectedFiles };
}

/**
 * When a queued todo already has kind=build (legacy / mis-posted), decide whether
 * to demote to the hunk path at execute time (defense in depth after classify).
 */
export function shouldDemoteBuildToHunks(
  description: string,
  command: string | undefined,
): boolean {
  if (!command?.trim()) return false;
  if (isTestAuthorDescription(description) || isFileAuthorIntent(description)) {
    // Explicit run of a bare test runner still builds
    if (isRunExecuteIntent(description) && !/\b(create|write|scaffold|generate)\b/i.test(description)) {
      return false;
    }
    return true;
  }
  return false;
}

/** Merge classification into a TodoQueue post input. */
export function buildCouncilTodoPost(
  input: {
    description: string;
    expectedFiles: readonly string[];
    createdBy: string;
    criterionId?: string;
    criteriaIds?: readonly string[];
  },
): PostTodoInput {
  const classified = classifyCouncilTodo(input.description, input.expectedFiles);
  return {
    description: input.description,
    expectedFiles: classified.expectedFiles,
    createdBy: input.createdBy,
    ...(input.criterionId ? { criterionId: input.criterionId } : {}),
    ...(input.criteriaIds ? { criteriaIds: input.criteriaIds } : {}),
    ...(classified.kind === "build" && classified.command
      ? { kind: "build" as const, command: classified.command }
      : {}),
  };
}
