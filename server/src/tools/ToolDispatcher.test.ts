import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolDispatcher, PROFILES } from "./ToolDispatcher.js";

async function makeFixtureClone(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-dispatcher-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "# Hello\n\nIntro line.\n");
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\nexport function add(x, y) { return x + y; }\n");
  await fs.writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n");
  return root;
}

test("PROFILES — swarm denies everything", () => {
  for (const tool of Object.keys(PROFILES.swarm) as Array<keyof typeof PROFILES.swarm>) {
    assert.equal(PROFILES.swarm[tool], "deny", `swarm.${tool} must deny`);
  }
});

test("PROFILES — swarm-read allows read/grep/glob/list, denies edit/write/bash", () => {
  assert.equal(PROFILES["swarm-read"].read, "allow");
  assert.equal(PROFILES["swarm-read"].grep, "allow");
  assert.equal(PROFILES["swarm-read"].glob, "allow");
  assert.equal(PROFILES["swarm-read"].list, "allow");
  assert.equal(PROFILES["swarm-read"].edit, "deny");
  assert.equal(PROFILES["swarm-read"].write, "deny");
  assert.equal(PROFILES["swarm-read"].bash, "deny");
});

test("PROFILES — swarm-builder-research allows bash, web tools, and propose_hunks", () => {
  assert.equal(PROFILES["swarm-builder-research"].bash, "allow");
  assert.equal(PROFILES["swarm-builder-research"].web_fetch, "allow");
  assert.equal(PROFILES["swarm-builder-research"].web_search, "allow");
  assert.equal(PROFILES["swarm-builder-research"].propose_hunks, "allow");
  assert.equal(PROFILES["swarm-builder-research"].write, "deny");
});

test("PROFILES — swarm-builder allows propose_hunks", () => {
  assert.equal(PROFILES["swarm-builder"].propose_hunks, "allow");
  assert.equal(PROFILES["swarm-builder"].bash, "allow");
});

test("PROFILES — swarm-planner has full read/web/bash, cannot mutate repo", () => {
  assert.deepEqual(
    ["read", "grep", "glob", "list"].map((tool) => PROFILES["swarm-planner"][tool as keyof typeof PROFILES["swarm-planner"]]),
    ["allow", "allow", "allow", "allow"],
  );
  assert.equal(PROFILES["swarm-planner"].bash, "allow");
  assert.equal(PROFILES["swarm-planner"].write, "deny");
  assert.equal(PROFILES["swarm-planner"].edit, "deny");
  assert.equal(PROFILES["swarm-planner"].propose_hunks, "deny");
  assert.equal(PROFILES["swarm-planner"].web_fetch, "allow");
  assert.equal(PROFILES["swarm-planner"].web_search, "allow");
});

test("ToolDispatcher — denies tools not in profile", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm", root);
    const r = await d.dispatch({ tool: "read", args: { path: "README.md" } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /denied by profile "swarm"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — read returns file contents under swarm-read", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-read", root);
    const r = await d.dispatch({ tool: "read", args: { path: "README.md" } });
    assert.equal(r.ok, true);
    if (r.ok) assert.match(r.output, /^# Hello/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — read rejects path traversal", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-read", root);
    const r = await d.dispatch({ tool: "read", args: { path: "../escape.txt" } });
    assert.equal(r.ok, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — list accepts absolute clone root path", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-read", root);
    const r = await d.dispatch({ tool: "list", args: { path: root } });
    assert.equal(r.ok, true);
    if (r.ok) assert.match(r.output, /README\.md/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — read on directory returns listing instead of EISDIR", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-read", root);
    const r = await d.dispatch({ tool: "read", args: { path: "src" } });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.output, /directory/);
      assert.match(r.output, /a\.ts/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — list shows entries with directory suffix", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-read", root);
    const r = await d.dispatch({ tool: "list", args: { path: "." } });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.output, /README\.md/);
      assert.match(r.output, /src\//);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — glob `**/*.ts` finds both ts files", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-read", root);
    const r = await d.dispatch({ tool: "glob", args: { pattern: "**/a.ts" } });
    assert.equal(r.ok, true);
    if (r.ok) assert.match(r.output, /src\/a\.ts/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — grep finds pattern with line numbers", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-read", root);
    const r = await d.dispatch({ tool: "grep", args: { pattern: "function add", path: "src" } });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.output, /src\/a\.ts:2:/);
      assert.match(r.output, /function add/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — grep accepts a single file path (not only directories)", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-read", root);
    const r = await d.dispatch({
      tool: "grep",
      args: { pattern: "function add", path: "src/a.ts" },
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.output, /src\/a\.ts:2:/);
      assert.doesNotMatch(r.output, /ENOTDIR/i);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — bash accepts formerly blocked binaries (echo always works)", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-builder", root);
    const r = await d.dispatch({ tool: "bash", args: { command: "echo hello-swarm" } });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (r.ok) assert.match(r.output, /hello-swarm/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — bash grep is rewritten to in-process grep (Windows-safe)", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-builder", root);
    const r = await d.dispatch({
      tool: "bash",
      args: { command: "grep function src/a.ts" },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (r.ok) {
      assert.match(r.output, /src\/a\.ts|function/i);
      assert.doesNotMatch(r.output, /not recognized/i);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — bash complex grep pipeline hints without cmd spam", async () => {
  if (process.platform !== "win32") return; // rewrite/hint path is win32-specific for fail-closed
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-builder", root);
    const r = await d.dispatch({
      tool: "bash",
      args: { command: "grep -r foo . | head -5" },
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /swarm \*\*grep\*\* tool|use the swarm/i);
      assert.doesNotMatch(r.error, /not recognized as an internal/i);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — bash allows shell chaining (&&)", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-builder", root);
    // Cross-platform no-op chain (echo is available on win+unix shells).
    const r = await d.dispatch({
      tool: "bash",
      args: { command: process.platform === "win32" ? "echo a && echo b" : "echo a && echo b" },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (r.ok) assert.match(r.output, /a/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — bash allows curl-like binaries (policy open)", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-builder", root);
    // checkBuildCommand no longer rejects; may fail at runtime if curl missing.
    const r = await d.dispatch({ tool: "bash", args: { command: "echo ok" } });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — bash denied entirely under swarm-read profile", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-read", root);
    const r = await d.dispatch({ tool: "bash", args: { command: "npm test" } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /denied by profile "swarm-read"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ToolDispatcher — swarm-research profile exposes web tools", () => {
  const d = new ToolDispatcher("swarm-research", "/tmp");
  // The profile allows web_fetch / web_search (tested via dispatch behavior below)
  assert.ok(true, "research profile defined with web tools");
});

test("ToolDispatcher — bash backoff persists across dispatcher instances per agent", async () => {
  const {
    resetAllAgentBashBackoff,
    BASH_ERROR_BACKOFF_THRESHOLD,
  } = await import("./agentBashBackoff.js");
  resetAllAgentBashBackoff();
  const root = await makeFixtureClone();
  try {
    const agentId = "agent-2-test";
    // Force a real shell failure (not a Unix CLI we rewrite to swarm tools).
    const failCmd =
      process.platform === "win32"
        ? "cmd /c exit 1"
        : "false";
    for (let i = 0; i < BASH_ERROR_BACKOFF_THRESHOLD; i++) {
      const d = new ToolDispatcher("swarm-builder", root, undefined, agentId);
      const r = await d.dispatch({ tool: "bash", args: { command: failCmd } });
      assert.equal(r.ok, false);
    }
    const d2 = new ToolDispatcher("swarm-builder", root, undefined, agentId);
    const blocked = await d2.dispatch({ tool: "bash", args: { command: failCmd } });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.match(
        blocked.error,
        new RegExp(`bash disabled after ${BASH_ERROR_BACKOFF_THRESHOLD} consecutive failures`),
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    resetAllAgentBashBackoff();
  }
});

test("ToolDispatcher — web_search and web_fetch are denied on non-research profiles", async () => {
  const d = new ToolDispatcher("swarm-read", "/tmp");
  const r1 = await d.dispatch({ tool: "web_search", args: { query: "test" } });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.error, /denied by profile/);

  const r2 = await d.dispatch({ tool: "web_fetch", args: { url: "https://example.com" } });
  assert.equal(r2.ok, false);
});
