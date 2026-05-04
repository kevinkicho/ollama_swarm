// T-Item-AutoRoute (2026-05-04): tests for the per-prompt model
// routing helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import { categorizeRole, selectModelForRole } from "./dynamicModelRoute.js";

test("categorizeRole — judgement roles", () => {
  assert.equal(categorizeRole("planner"), "planner");
  assert.equal(categorizeRole("orchestrator"), "planner");
  assert.equal(categorizeRole("reducer"), "planner");
  assert.equal(categorizeRole("auditor"), "auditor");
  assert.equal(categorizeRole("judge"), "judge");
});

test("categorizeRole — structural roles → worker", () => {
  for (const role of [
    "worker",
    "mapper",
    "drafter",
    "explorer",
    "peer",
    "pro",
    "con",
    "role-diff",
    "mid-lead",
  ]) {
    assert.equal(categorizeRole(role), "worker", `expected ${role} → worker`);
  }
});

test("categorizeRole — unknown role defaults to worker", () => {
  assert.equal(categorizeRole("totally-novel-role"), "worker");
});

test("selectModelForRole — planner role picks plannerModel when set", () => {
  const got = selectModelForRole("planner", {
    model: "default",
    plannerModel: "smart",
    workerModel: "fast",
  });
  assert.equal(got, "smart");
});

test("selectModelForRole — planner falls back to model when plannerModel unset", () => {
  const got = selectModelForRole("planner", { model: "default" });
  assert.equal(got, "default");
});

test("selectModelForRole — worker role picks workerModel when set", () => {
  const got = selectModelForRole("worker", {
    model: "default",
    workerModel: "fast",
    plannerModel: "smart",
  });
  assert.equal(got, "fast");
});

test("selectModelForRole — worker falls back to model when workerModel unset", () => {
  const got = selectModelForRole("worker", { model: "default" });
  assert.equal(got, "default");
});

test("selectModelForRole — auditor falls auditorModel → plannerModel → model", () => {
  // auditorModel set wins
  assert.equal(
    selectModelForRole("auditor", {
      model: "m",
      auditorModel: "audit",
      plannerModel: "plan",
    }),
    "audit",
  );
  // auditorModel unset → plannerModel
  assert.equal(
    selectModelForRole("auditor", { model: "m", plannerModel: "plan" }),
    "plan",
  );
  // both unset → model
  assert.equal(selectModelForRole("auditor", { model: "m" }), "m");
});

test("selectModelForRole — judge follows the auditor fallback chain", () => {
  assert.equal(
    selectModelForRole("judge", {
      model: "m",
      auditorModel: "audit",
      plannerModel: "plan",
    }),
    "audit",
  );
  assert.equal(
    selectModelForRole("judge", { model: "m", plannerModel: "plan" }),
    "plan",
  );
  assert.equal(selectModelForRole("judge", { model: "m" }), "m");
});

test("selectModelForRole — orchestrator + reducer route to planner-tier", () => {
  assert.equal(
    selectModelForRole("orchestrator", { model: "m", plannerModel: "plan" }),
    "plan",
  );
  assert.equal(
    selectModelForRole("reducer", { model: "m", plannerModel: "plan" }),
    "plan",
  );
});

test("selectModelForRole — mapper + mid-lead route to worker-tier", () => {
  assert.equal(
    selectModelForRole("mapper", { model: "m", workerModel: "fast" }),
    "fast",
  );
  assert.equal(
    selectModelForRole("mid-lead", { model: "m", workerModel: "fast" }),
    "fast",
  );
});
