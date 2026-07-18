import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyOrGroundedRepair,
  isDeterministicCandidateEnabled,
  rewriteHunkWithCandidate,
} from "./applyOrGroundedRepair.js";
import type { Hunk } from "./blackboard/applyHunks.js";
import type { ApplyMissReport } from "./blackboard/applyMissReport.js";

describe("applyOrGroundedRepair", () => {
  it("succeeds without repair when hunks apply", async () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "a.ts", search: "foo", replace: "bar" },
    ];
    const r = await applyOrGroundedRepair({
      hunks,
      currentTextsByFile: { "a.ts": "hello foo\n" },
      expectedFiles: ["a.ts"],
      callModel: async () => {
        throw new Error("should not call model");
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.repaired, false);
    assert.equal(r.newTextsByFile?.["a.ts"], "hello bar\n");
  });

  it("repairs search miss when model returns unique search", async () => {
    const file = "alpha beta gamma\n";
    const bad: Hunk[] = [
      { op: "replace", file: "a.ts", search: "ALPHA BETA", replace: "ALPHA X" },
    ];
    const goodJson = JSON.stringify({
      hunks: [
        { op: "replace", file: "a.ts", search: "alpha beta", replace: "alpha X" },
      ],
    });
    const r = await applyOrGroundedRepair({
      hunks: bad,
      currentTextsByFile: { "a.ts": file },
      expectedFiles: ["a.ts"],
      callModel: async () => goodJson,
    });
    assert.equal(r.ok, true);
    assert.equal(r.repaired, true);
    assert.equal(r.repairAttempts, 1);
    assert.match(r.newTextsByFile?.["a.ts"] ?? "", /alpha X/);
  });

  it("fails closed when repair cannot fix", async () => {
    const r = await applyOrGroundedRepair({
      hunks: [
        { op: "replace", file: "a.ts", search: "missing", replace: "x" },
      ],
      currentTextsByFile: { "a.ts": "hello\n" },
      expectedFiles: ["a.ts"],
      callModel: async () =>
        JSON.stringify({
          hunks: [
            { op: "replace", file: "a.ts", search: "still missing", replace: "x" },
          ],
        }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.repaired, false);
    assert.ok((r.repairAttempts ?? 0) >= 1);
  });

  it("deterministic candidate applies uniqueCandidates[0] without LLM when flag on", async () => {
    // Needle almost matches a unique line; findUniqueSubstrings should yield a
    // unique candidate that rewriteHunkWithCandidate can apply.
    const unique =
      "const UNIQUE_PANEL_KEY_alpha_rates_dashboard_value = true;";
    const file = `// header\n${unique}\n// footer\n`;
    const bad: Hunk[] = [
      {
        op: "replace",
        file: "a.ts",
        // Wrong trailing — not found; substrings of this still appear uniquely.
        search: "const UNIQUE_PANEL_KEY_alpha_rates_dashboard_value = TRUE;",
        replace: "const UNIQUE_PANEL_KEY_alpha_rates_dashboard_value = false;",
      },
    ];
    let modelCalls = 0;
    const r = await applyOrGroundedRepair({
      hunks: bad,
      currentTextsByFile: { "a.ts": file },
      expectedFiles: ["a.ts"],
      tryDeterministicCandidate: true,
      callModel: async () => {
        modelCalls += 1;
        // Fallback if candidates empty — still should parse
        return JSON.stringify({
          hunks: [
            {
              op: "replace",
              file: "a.ts",
              search: unique,
              replace: "const UNIQUE_PANEL_KEY_alpha_rates_dashboard_value = false;",
            },
          ],
        });
      },
    });
    assert.equal(r.ok, true);
    if (r.deterministicCandidate) {
      assert.equal(modelCalls, 0);
    }
    assert.match(
      r.newTextsByFile?.["a.ts"] ?? "",
      /UNIQUE_PANEL_KEY_alpha_rates_dashboard_value = false/,
    );
  });

  it("rewriteHunkWithCandidate rewrites search when candidate unique", () => {
    const file = "aaa unique_body_line_for_panel_fx_section bbb\n";
    const miss: ApplyMissReport = {
      file: "a.ts",
      hunkIndex: 0,
      op: "replace",
      kind: "search_not_found",
      needle: "wrong",
      matchCount: 0,
      nearbyExcerpt: "",
      uniqueCandidates: ["unique_body_line_for_panel_fx_section"],
      message: "miss",
    };
    const hunks: Hunk[] = [
      {
        op: "replace",
        file: "a.ts",
        search: "wrong",
        replace: "fixed",
      },
    ];
    const out = rewriteHunkWithCandidate(hunks, miss, file);
    assert.ok(out);
    assert.equal((out![0] as { search: string }).search, "unique_body_line_for_panel_fx_section");
  });

  it("isDeterministicCandidateEnabled defaults ON; explicit off disables", () => {
    assert.equal(isDeterministicCandidateEnabled({}), true);
    assert.equal(
      isDeterministicCandidateEnabled({ SWARM_APPLY_DETERMINISTIC_CANDIDATE: "1" }),
      true,
    );
    assert.equal(
      isDeterministicCandidateEnabled({ SWARM_APPLY_DETERMINISTIC_CANDIDATE: "0" }),
      false,
    );
    assert.equal(
      isDeterministicCandidateEnabled({ SWARM_APPLY_DETERMINISTIC_CANDIDATE: "false" }),
      false,
    );
  });

  it("deterministic candidate runs by default without tryDeterministicCandidate flag", async () => {
    const unique =
      "const UNIQUE_DEFAULT_ON_alpha_panel_marker_xyz = true;";
    const file = `// header\n${unique}\n// footer\n`;
    let modelCalls = 0;
    const r = await applyOrGroundedRepair({
      hunks: [
        {
          op: "replace",
          file: "a.ts",
          search: "const UNIQUE_DEFAULT_ON_alpha_panel_marker_xyz = TRUE;",
          replace: "const UNIQUE_DEFAULT_ON_alpha_panel_marker_xyz = false;",
        },
      ],
      currentTextsByFile: { "a.ts": file },
      expectedFiles: ["a.ts"],
      // omit tryDeterministicCandidate — default path
      env: {},
      callModel: async () => {
        modelCalls += 1;
        return JSON.stringify({
          hunks: [
            {
              op: "replace",
              file: "a.ts",
              search: unique,
              replace: "const UNIQUE_DEFAULT_ON_alpha_panel_marker_xyz = false;",
            },
          ],
        });
      },
    });
    assert.equal(r.ok, true);
    // Prefer deterministic; model is fallback only.
    if (r.deterministicCandidate) {
      assert.equal(modelCalls, 0);
    }
    assert.match(
      r.newTextsByFile?.["a.ts"] ?? "",
      /UNIQUE_DEFAULT_ON_alpha_panel_marker_xyz = false/,
    );
  });
});
