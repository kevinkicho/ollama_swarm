import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TodoQueue } from "./TodoQueue.js";
import { FindingsLog } from "./FindingsLog.js";
import { makeTodoQueueWrappers } from "./todoQueueWrappers.js";
import { applyAuditorResult } from "./auditorRunner.js";
import type { AuditorContext } from "./auditorRunner.js";
import type { ExitContract } from "./types.js";
import { v2QueueTodoToWireTodo } from "./boardWireCompat.js";

function makeCtx(contract: ExitContract) {
  const todoQueue = new TodoQueue();
  const findings = new FindingsLog();
  const events: string[] = [];
  const wrappers = makeTodoQueueWrappers({
    todoQueue,
    findings,
    emit: () => {},
    scheduleStateWrite: () => {},
    onTerminal: () => {},
    onFailed: () => {},
  });

  const ctx: AuditorContext = {
    getContract: () => contract,
    getAuditInvocations: () => 1,
    incrementAuditInvocations: () => {},
    getMaxAuditInvocations: () => Infinity,
    getAuditor: () => undefined,
    getStopping: () => false,
    boardListTodos: () => todoQueue.list().map(v2QueueTodoToWireTodo),
    getFindingsList: () => [],
    readExpectedFiles: async () => ({}),
    getActive: () => ({}),
    cloneContract: (c) => structuredClone(c),
    emitContractUpdated: () => {},
    appendSystem: (msg) => events.push(msg),
    appendAgent: () => {},
    emit: () => {},
    updateAgentModel: () => {},
    promptPlannerSafely: async () => ({ response: "{}", agentUsed: { id: "agent-6", index: 6 } as any }),
    wrappers,
    allCriteriaResolvedSnapshot: () => false,
    v2ObserverApply: () => {},
    getWorkTranscript: () => [],
  };

  return { ctx, todoQueue, events };
}

describe("applyAuditorResult supersede", () => {
  it("skips prior non-terminal todos for a criterion before posting revised plan", () => {
    const contract: ExitContract = {
      missionStatement: "test",
      criteria: [
        {
          id: "c1",
          description: "make script",
          expectedFiles: ["a.py"],
          status: "unmet",
          addedAt: 1,
        },
      ],
    };

    const { ctx, todoQueue } = makeCtx(contract);
    const oldId = todoQueue.post({
      description: "old attempt",
      expectedFiles: ["src/a.py"],
      createdBy: "agent-1",
      createdAt: 1,
      criterionId: "c1",
    });
    todoQueue.dequeue("agent-4");

    applyAuditorResult(ctx, {
      verdicts: [
        {
          id: "c1",
          status: "unmet",
          rationale: "still missing",
          todos: [
            {
              description: "revised attempt",
              expectedFiles: ["a.py"],
            },
          ],
        },
      ],
      newCriteria: [],
    }, { id: "agent-1", index: 1 } as any);

    assert.equal(todoQueue.get(oldId)?.status, "skipped");
    const pending = todoQueue.list().filter((t) => t.status === "pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].description, "revised attempt");
  });
});