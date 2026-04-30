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

test("ToolDispatcher — bash refuses with not-implemented under swarm-builder", async () => {
  const root = await makeFixtureClone();
  try {
    const d = new ToolDispatcher("swarm-builder", root);
    const r = await d.dispatch({ tool: "bash", args: { command: "ls" } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /not yet implemented/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
