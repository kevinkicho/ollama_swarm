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

/** Detect build-style todos from description text (run scripts, pytest, etc.). */
export function classifyCouncilTodo(
  description: string,
  expectedFiles: readonly string[],
): ClassifiedCouncilTodo {
  const lower = description.toLowerCase();

  // Prefer hunks when the todo is clearly a file edit, even if it quotes code.
  const editIntent =
    /\b(fix|add|update|rewrite|replace|implement|refactor|remove|delete|indent|clean\s*up|patch)\b/i.test(
      description,
    );
  const hasCodeFiles = expectedFiles.some((f) =>
    /\.(py|ts|tsx|js|jsx|go|rs|java|c|cpp|h|cs|rb|php|md|json|yml|yaml)$/i.test(f),
  );
  const runIntent = /\b(run|execute)\b/i.test(description);

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
  // Edit todos that merely quote code stay on the hunks path. Only promote to
  // build when we have a real shell command and either no edit framing, or an
  // explicit run/execute intent alongside the edit.
  if (backtickBuild) {
    const preferHunks = editIntent && hasCodeFiles && !runIntent;
    if (!preferHunks) {
      return { kind: "build", command: backtickBuild, expectedFiles };
    }
  }

  // Pure "Run foo.py" without edit framing
  const runPy = /\brun\s+([^\s`]+\.py)\b/i.exec(description);
  if (runPy && !editIntent) {
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

  if (/\bpytest\b/.test(lower) && !editIntent) {
    const cmd = "pytest";
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  const pythonMatch = /\b(?:python3?)\s+(\S+)/i.exec(description);
  if (pythonMatch && !editIntent) {
    const cmd = `python ${pythonMatch[1]}`;
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  const pkgRun = /\b(npm|npx|yarn|pnpm|bun|bunx)\s+(\S+(?:\s+\S+)*)/i.exec(description);
  if (pkgRun && /\b(run|test|install)\b/i.test(pkgRun[2]!) && !editIntent) {
    const cmd = `${pkgRun[1]} ${pkgRun[2]}`.trim();
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  for (const runner of ["jest", "vitest", "mocha", "eslint", "prettier", "tsc"]) {
    if (new RegExp(`\\b${runner}\\b`).test(lower) && !editIntent) {
      const cmd = runner;
      if (checkBuildCommand(cmd).ok) {
        return { kind: "build", command: cmd, expectedFiles };
      }
    }
  }

  return { kind: "hunks", expectedFiles };
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
