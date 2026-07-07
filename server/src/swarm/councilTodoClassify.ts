import { checkBuildCommand } from "./blackboard/buildCommandAllowlist.js";
import type { PostTodoInput } from "./blackboard/TodoQueue.js";

export interface ClassifiedCouncilTodo {
  kind: "hunks" | "build";
  command?: string;
  expectedFiles: readonly string[];
}

const BACKTICK_CMD_RE = /`([^`]+)`/;

/** Detect build-style todos from description text (run scripts, pytest, etc.). */
export function classifyCouncilTodo(
  description: string,
  expectedFiles: readonly string[],
): ClassifiedCouncilTodo {
  const lower = description.toLowerCase();

  const backtick = BACKTICK_CMD_RE.exec(description);
  if (backtick) {
    const cmd = backtick[1]!.trim();
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  const runPy = /\brun\s+([^\s`]+\.py)\b/i.exec(description);
  if (runPy) {
    const cmd = `python ${runPy[1]}`;
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  if (/\bpytest\b/.test(lower)) {
    const cmd = "pytest";
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  const pythonMatch = /\b(?:python3?)\s+(\S+)/i.exec(description);
  if (pythonMatch) {
    const cmd = `python ${pythonMatch[1]}`;
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  const pkgRun = /\b(npm|npx|yarn|pnpm|bun|bunx)\s+(\S+(?:\s+\S+)*)/i.exec(description);
  if (pkgRun && /\b(run|test|install)\b/i.test(pkgRun[2]!)) {
    const cmd = `${pkgRun[1]} ${pkgRun[2]}`.trim();
    if (checkBuildCommand(cmd).ok) {
      return { kind: "build", command: cmd, expectedFiles };
    }
  }

  for (const runner of ["jest", "vitest", "mocha", "eslint", "prettier", "tsc"]) {
    if (new RegExp(`\\b${runner}\\b`).test(lower)) {
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