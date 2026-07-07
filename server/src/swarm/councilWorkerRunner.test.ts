import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "councilWorkerRunner.ts"), "utf8");

test("councilWorkerRunner marks thinking before todo prompt and ready after", () => {
  assert.match(SRC, /setWorkerThinking\(state, agent\)/, "must mark thinking when a todo starts");
  assert.match(SRC, /setWorkerReady\(state, agent\)/, "must mark ready when a todo finishes");
  assert.match(SRC, /thinkingSince/, "thinking status must include thinkingSince for sidebar ticker");
});

test("councilWorkerRunner — literature research + web tools profile", () => {
  assert.match(SRC, /runCouncilLiteratureResearch/, "must run literature pre-pass for research todos");
  assert.match(SRC, /isLiteratureTodo/, "must detect literature todos");
  assert.match(SRC, /effectiveToolProfileId\("swarm-builder"/, "must upgrade builder profile when web tools on");
  assert.match(SRC, /researchNotes/, "must pass research notes into worker prompt");
});

test("councilWorkerRunner — preserves worker skip reason", () => {
  assert.match(SRC, /skip\(todo\.id, result\.reason\)/, "must store actual skip reason on todo");
});

test("councilWorkerRunner — routes build todos through executeCouncilBuildTodo", () => {
  assert.match(SRC, /executeCouncilBuildTodo/, "must handle build-style todos");
  assert.match(SRC, /todo\.kind === "build"/, "must branch on build kind");
  assert.match(SRC, /checkBuildCommand/, "must enforce build command allowlist");
});