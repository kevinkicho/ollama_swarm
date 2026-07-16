import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicToolCoachHint } from "./deterministicToolCoach.js";

test("deterministicToolCoachHint — Windows bash unix binaries", () => {
  const h = deterministicToolCoachHint(
    "bash",
    "bash: `wc` is not available as a Windows shell command. Use read/grep/glob.",
  );
  assert.ok(h);
  assert.match(h!, /Windows|read, grep/i);
});

test("deterministicToolCoachHint — bash disabled after failures", () => {
  const h = deterministicToolCoachHint(
    "bash",
    "bash disabled after 4 consecutive failures — use read, grep, or glob instead",
  );
  assert.ok(h);
  assert.match(h!, /do not use bash|read/i);
});

test("deterministicToolCoachHint — overlong grep", () => {
  const h = deterministicToolCoachHint("grep", "pattern too long (200 character limit)");
  assert.ok(h);
  assert.match(h!, /200|short/i);
});

test("deterministicToolCoachHint — hunk search miss", () => {
  const h = deterministicToolCoachHint("propose_hunks", 'hunk[0] op "replace": "search" text not found in file');
  assert.ok(h);
  assert.match(h!, /anchor|Re-read|search/i);
});

test("deterministicToolCoachHint — unknown returns null", () => {
  assert.equal(deterministicToolCoachHint("read", "ok"), null);
});
