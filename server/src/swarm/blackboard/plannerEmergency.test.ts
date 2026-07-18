import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildEmergencyPlannerTodos } from "./plannerRunner.js";
import type { PlannerSeed } from "./prompts/planner.js";
import type { ExitContract } from "./types.js";

function seed(overrides: Partial<PlannerSeed> = {}): PlannerSeed {
  return {
    repoUrl: "https://example.com/r",
    clonePath: "/tmp/r",
    topLevel: ["README.md", "01_complex_explorer.html"],
    repoFiles: [
      "README.md",
      "01_complex_explorer.html",
      "02_penrose_tiling.html",
      "src/index.ts",
    ],
    readmeExcerpt: "# r\n",
    ...overrides,
  };
}

describe("buildEmergencyPlannerTodos", () => {
  it("prefers unmet contract criteria with grounded files", () => {
    const contract: ExitContract = {
      missionStatement: "ship",
      criteria: [
        {
          id: "c1",
          description: "Expand complex explorer tabs",
          expectedFiles: ["01_complex_explorer.html"],
          status: "unmet",
          addedAt: 1,
        },
        {
          id: "c2",
          description: "done thing",
          expectedFiles: ["README.md"],
          status: "met",
          addedAt: 1,
        },
      ],
    };
    const todos = buildEmergencyPlannerTodos(seed(), contract);
    assert.ok(todos.length >= 1);
    assert.deepEqual(todos[0]!.expectedFiles, ["01_complex_explorer.html"]);
    assert.match(todos[0]!.description, /Emergency board seed/);
  });

  it("falls back to scored repo files when no contract", () => {
    const todos = buildEmergencyPlannerTodos(seed(), null);
    assert.ok(todos.length >= 1);
    assert.ok(todos.every((t) => t.expectedFiles.length > 0));
    assert.ok(
      todos.some((t) => t.expectedFiles[0]!.endsWith(".html")),
      "prefer html modules",
    );
  });

  it("uses userDirective file mentions as last resort", () => {
    const todos = buildEmergencyPlannerTodos(
      seed({
        repoFiles: ["only_real.ts"],
        userDirective: "please edit only_real.ts carefully",
      }),
      null,
    );
    // scored path may pick only_real.ts via .ts scoring; either path is fine
    assert.ok(todos.length >= 1);
    assert.ok(todos.some((t) => t.expectedFiles.includes("only_real.ts")));
  });
});
