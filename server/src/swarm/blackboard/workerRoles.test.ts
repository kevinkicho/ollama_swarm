import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assignWorkerRole,
  WORKER_ROLE_CATALOG,
  type WorkerRole,
} from "./workerRoles.js";

describe("assignWorkerRole — Unit 59 (59a)", () => {
  it("assigns each catalog role at least once for ordinals 1..N (where N == catalog size)", () => {
    const seen = new Set<string>();
    for (let i = 1; i <= WORKER_ROLE_CATALOG.length; i++) {
      seen.add(assignWorkerRole(i).name);
    }
    assert.equal(seen.size, WORKER_ROLE_CATALOG.length);
  });

  it("cycles deterministically when ordinal exceeds catalog size", () => {
    // 1, 2, 3 → catalog[0], [1], [2]
    // 4, 5, 6 → catalog[0], [1], [2] again
    for (let i = 1; i <= WORKER_ROLE_CATALOG.length * 3; i++) {
      const role = assignWorkerRole(i);
      const expectedIdx = (i - 1) % WORKER_ROLE_CATALOG.length;
      assert.equal(role.name, WORKER_ROLE_CATALOG[expectedIdx]!.name);
    }
  });

  it("clamps ordinal=0 to ordinal=1 (defensive)", () => {
    // Defensive case: caller passes 0 by mistake. Treat as first worker.
    assert.equal(assignWorkerRole(0).name, WORKER_ROLE_CATALOG[0]!.name);
  });

  it("each catalog entry has a non-empty name + guidance", () => {
    for (const role of WORKER_ROLE_CATALOG) {
      assert.ok(role.name.length > 0);
      assert.ok(role.guidance.trim().length > 50, `guidance too short for ${role.name}`);
      // Guidance starts with a stable prefix the worker prompt will see.
      assert.match(role.guidance, /^ROLE BIAS — /);
    }
  });

  it("guidance uses the canonical biases (correctness / simplicity / consistency)", () => {
    const names = WORKER_ROLE_CATALOG.map((r: WorkerRole) => r.name).sort();
    assert.deepEqual(names, ["consistency", "correctness", "simplicity"]);
  });
});
