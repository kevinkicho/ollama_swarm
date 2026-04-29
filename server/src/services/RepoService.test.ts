import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deriveCloneDir,
  isLikelyBinaryPath,
  LIST_REPO_IGNORED_DIRS,
  RepoService,
} from "./RepoService.js";

test("deriveCloneDir — standard github URL", () => {
  const got = deriveCloneDir("https://github.com/sindresorhus/is-odd", "/tmp/runs");
  assert.equal(got, path.resolve("/tmp/runs", "is-odd"));
});

test("deriveCloneDir — strips .git suffix", () => {
  const got = deriveCloneDir("https://github.com/kevinkicho/multi-agent-orchestrator.git", "/tmp/runs");
  assert.equal(got, path.resolve("/tmp/runs", "multi-agent-orchestrator"));
});

test("deriveCloneDir — strips trailing slash before picking last segment", () => {
  const got = deriveCloneDir("https://github.com/sindresorhus/is-odd/", "/tmp/runs");
  assert.equal(got, path.resolve("/tmp/runs", "is-odd"));
});

test("deriveCloneDir — case-insensitive .git strip", () => {
  const got = deriveCloneDir("https://example.com/owner/Repo.GIT", "/tmp/runs");
  assert.equal(got, path.resolve("/tmp/runs", "Repo"));
});

test("deriveCloneDir — resolves relative parent path against cwd", () => {
  const got = deriveCloneDir("https://github.com/o/r", "runs");
  assert.equal(got, path.resolve("runs", "r"));
});

test("deriveCloneDir — accepts Windows-style parent path", () => {
  // path.resolve normalizes; on Windows it preserves the drive and backslashes,
  // on POSIX the backslash is just a character in a segment. Either way the repo
  // name must be appended.
  const got = deriveCloneDir("https://github.com/o/r", "C:\\Users\\x\\runs");
  assert.ok(got.endsWith("r"), `expected ${got} to end with "r"`);
});

test("deriveCloneDir — throws on unparseable URL", () => {
  assert.throws(() => deriveCloneDir("not a url", "/tmp/runs"), /invalid repo URL/);
});

test("deriveCloneDir — throws when URL has no path segment", () => {
  assert.throws(
    () => deriveCloneDir("https://github.com/", "/tmp/runs"),
    /cannot derive repo name/,
  );
});

test("deriveCloneDir — throws when last segment is just .git", () => {
  assert.throws(
    () => deriveCloneDir("https://github.com/owner/.git", "/tmp/runs"),
    /cannot derive repo name/,
  );
});

// ---------------------------------------------------------------------------
// Grounding Unit 6a: listRepoFiles + related helpers
// ---------------------------------------------------------------------------

async function makeTmpRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "swarm-listrepo-"));
}

async function touch(root: string, rel: string, content = ""): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

test("isLikelyBinaryPath — catches common image/archive/font/media extensions", () => {
  for (const name of ["foo.png", "foo.JPG", "bar.zip", "baz.woff2", "x.mp4", "x.pdf"]) {
    assert.equal(isLikelyBinaryPath(name), true, `expected ${name} → binary`);
  }
});

test("isLikelyBinaryPath — returns false for typical source/text files", () => {
  for (const name of ["README.md", "index.ts", "pyproject.toml", "style.css", ".env", "Makefile"]) {
    assert.equal(isLikelyBinaryPath(name), false, `expected ${name} → text`);
  }
});

test("LIST_REPO_IGNORED_DIRS — covers the high-frequency offenders", () => {
  // If any of these drops out of the set, the planner starts seeing
  // node_modules/ paths in its seed and proposing edits there. Regression
  // guard so a careless prune of the set breaks this test loudly.
  for (const d of [".git", "node_modules", "dist", "build", "coverage", ".next"]) {
    assert.ok(LIST_REPO_IGNORED_DIRS.has(d), `expected ${d} to be ignored`);
  }
});

test("listRepoFiles — returns repo-relative paths with forward slashes", async () => {
  const root = await makeTmpRepo();
  try {
    await touch(root, "README.md");
    await touch(root, "src/index.ts");
    await touch(root, "src/lib/helper.ts");
    const svc = new RepoService();
    const files = await svc.listRepoFiles(root);
    assert.ok(files.includes("README.md"));
    assert.ok(files.includes("src/index.ts"));
    assert.ok(files.includes("src/lib/helper.ts"));
    // Even on Windows the output uses forward slashes so the LLM gets a
    // consistent view across hosts.
    for (const f of files) {
      assert.equal(f.includes("\\"), false, `forward slashes only; got ${f}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("listRepoFiles — skips every entry in LIST_REPO_IGNORED_DIRS", async () => {
  const root = await makeTmpRepo();
  try {
    await touch(root, "keep.ts");
    await touch(root, "node_modules/pkg/index.js");
    await touch(root, ".git/HEAD", "ref: refs/heads/main\n");
    await touch(root, "dist/bundle.js");
    await touch(root, "coverage/lcov.info");
    await touch(root, ".next/cache/stuff");
    const svc = new RepoService();
    const files = await svc.listRepoFiles(root);
    assert.deepEqual(files, ["keep.ts"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("listRepoFiles — skips binary files by extension", async () => {
  const root = await makeTmpRepo();
  try {
    await touch(root, "README.md", "# hi\n");
    await touch(root, "logo.png", "\x89PNG\r\n");
    await touch(root, "release.zip", "PK...");
    await touch(root, "font.woff2", "wOF2...");
    const svc = new RepoService();
    const files = await svc.listRepoFiles(root);
    assert.deepEqual(files, ["README.md"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("listRepoFiles — caps at maxFiles and returns shallow files first (BFS)", async () => {
  const root = await makeTmpRepo();
  try {
    // One shallow file, then nine deep ones. BFS should surface the shallow
    // one first, so with maxFiles=5 we'd still see README.md.
    await touch(root, "README.md");
    for (let i = 0; i < 9; i += 1) {
      await touch(root, `src/deep/nested/mod${i}.ts`);
    }
    const svc = new RepoService();
    const files = await svc.listRepoFiles(root, { maxFiles: 5 });
    assert.equal(files.length, 5);
    assert.equal(files[0], "README.md");
    assert.ok(files.slice(1).every((f) => f.startsWith("src/deep/nested/")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("listRepoFiles — produces sorted order within each directory for determinism", async () => {
  const root = await makeTmpRepo();
  try {
    // Creating out-of-order so we rely on the walker's sort rather than the
    // filesystem's iteration order (which varies by OS/FS).
    await touch(root, "zeta.ts");
    await touch(root, "alpha.ts");
    await touch(root, "beta.ts");
    const svc = new RepoService();
    const files = await svc.listRepoFiles(root);
    assert.deepEqual(files, ["alpha.ts", "beta.ts", "zeta.ts"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("listRepoFiles — returns [] for a missing clone path without throwing", async () => {
  // Grounding shouldn't crash a run just because the path is wrong — callers
  // should degrade to the thinner seed instead. Mirrors listTopLevel's
  // swallow-errors contract.
  const svc = new RepoService();
  const files = await svc.listRepoFiles(path.join(os.tmpdir(), "definitely-not-a-real-path-xyz123"));
  assert.deepEqual(files, []);
});

test("listRepoFiles — is deterministic for a given tree (same tree → same output)", async () => {
  const root = await makeTmpRepo();
  try {
    await touch(root, "README.md");
    await touch(root, "src/a.ts");
    await touch(root, "src/b.ts");
    await touch(root, "tests/a.test.ts");
    const svc = new RepoService();
    const a = await svc.listRepoFiles(root);
    const b = await svc.listRepoFiles(root);
    assert.deepEqual(a, b);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Unit 20: writeOpencodeConfig synthesizes two agent profiles. `swarm`
// stays no-tools (blackboard worker safety — must return JSON diffs);
// `swarm-read` enables read-only inspection tools so discussion presets
// can actually use the file-read / grep / glob calls their prompts ask
// for. These tests lock down the safety property: NO write/edit/bash
// for either profile, ever.
test("writeOpencodeConfig — both swarm and swarm-read agent profiles present", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-cfg-"));
  try {
    const repos = new RepoService();
    await repos.writeOpencodeConfig(root, "test-model");
    const raw = await fs.readFile(path.join(root, "opencode.json"), "utf8");
    const cfg = JSON.parse(raw) as { agent?: Record<string, unknown> };
    assert.ok(cfg.agent, "agent block must exist");
    assert.ok(cfg.agent["swarm"], "swarm profile must exist");
    assert.ok(cfg.agent["swarm-read"], "swarm-read profile must exist");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// #234 (2026-04-27 evening): migrated to v2 SDK. The deprecated `tools`
// field no longer exists; v2 Agent type uses `permission: PermissionRuleset`
// exclusively. Tests now assert permission-rule shape instead.
test("writeOpencodeConfig — swarm profile denies all tools (blackboard worker safety)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-cfg-"));
  try {
    const repos = new RepoService();
    await repos.writeOpencodeConfig(root, "test-model");
    const cfg = JSON.parse(await fs.readFile(path.join(root, "opencode.json"), "utf8")) as {
      agent: Record<string, { tools?: unknown; permission?: Record<string, string> }>;
    };
    const profile = cfg.agent["swarm"];
    assert.equal(profile.tools, undefined, "swarm profile must NOT carry the deprecated v1 tools field");
    assert.equal(profile.permission?.["*"], "deny", "swarm.permission['*'] must deny all tools");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig — swarm-read allows read/grep/glob, denies everything else", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-cfg-"));
  try {
    const repos = new RepoService();
    await repos.writeOpencodeConfig(root, "test-model");
    const cfg = JSON.parse(await fs.readFile(path.join(root, "opencode.json"), "utf8")) as {
      agent: Record<string, { tools?: unknown; permission?: Record<string, string> }>;
    };
    const profile = cfg.agent["swarm-read"];
    assert.equal(profile.tools, undefined, "swarm-read must NOT carry the deprecated v1 tools field");
    // Catch-all deny first, then specific allows. Last-rule-wins per opencode docs.
    assert.equal(profile.permission?.["*"], "deny", "swarm-read.permission['*'] must be the catch-all deny");
    assert.equal(profile.permission?.read, "allow");
    assert.equal(profile.permission?.grep, "allow");
    assert.equal(profile.permission?.glob, "allow");
    // Write-side stays denied via the catch-all (no explicit allow override)
    assert.notEqual(profile.permission?.edit, "allow", "edit must NOT be allowed in swarm-read");
    assert.notEqual(profile.permission?.bash, "allow", "bash must NOT be allowed in swarm-read");
    assert.notEqual(profile.permission?.write, "allow", "write must NOT be allowed in swarm-read");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Unit 26: Playwright MCP integration. Default OFF — no mcp block,
// no swarm-ui profile. When MCP_PLAYWRIGHT_ENABLED=true, both appear.
// The MCP_PLAYWRIGHT_ENABLED flag is read at config-load time, so we
// can't easily toggle it in a unit test (would require module reload
// with a different process.env). Instead we test the DEFAULT-OFF
// shape here, and the shape of the mcp/swarm-ui additions is locked
// down by eyeballing + the integration test when the user runs with
// the flag enabled. That's the Unit 20 testing pattern.
test("writeOpencodeConfig — mcp block absent by default (Unit 26 OFF)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-cfg-"));
  try {
    const repos = new RepoService();
    await repos.writeOpencodeConfig(root, "test-model");
    const cfg = JSON.parse(await fs.readFile(path.join(root, "opencode.json"), "utf8")) as Record<string, unknown>;
    // Default: MCP_PLAYWRIGHT_ENABLED=false → no mcp block, no swarm-ui
    assert.equal(cfg.mcp, undefined, "mcp block should be absent when flag is off");
    const agents = cfg.agent as Record<string, unknown>;
    assert.equal(agents["swarm-ui"], undefined, "swarm-ui profile should be absent when flag is off");
    // Pre-Unit-26 profiles must still be present
    assert.ok(agents["swarm"], "swarm profile stays");
    assert.ok(agents["swarm-read"], "swarm-read profile stays");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Phase 1 of #314 (multi-provider): writeOpencodeConfig groups input
// models by detected provider (anthropic/, openai/, or unprefixed →
// ollama). For each non-empty group, an appropriate provider block
// lands in opencode.json. Backward-compatible with the historical
// single-string-ollama-model call signature — every existing test
// above passes "test-model" with no prefix and gets the same shape.

test("writeOpencodeConfig — anthropic-prefixed model emits an anthropic provider block (no ollama block)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-cfg-"));
  try {
    const repos = new RepoService();
    await repos.writeOpencodeConfig(root, "anthropic/claude-opus-4-7");
    const cfg = JSON.parse(await fs.readFile(path.join(root, "opencode.json"), "utf8")) as {
      provider: Record<string, { npm?: string; options?: Record<string, unknown>; models?: Record<string, unknown> }>;
    };
    assert.ok(cfg.provider.anthropic, "anthropic provider block must exist");
    assert.equal(cfg.provider.anthropic.npm, "@ai-sdk/anthropic");
    // No apiKey echoed into config — env-inherited
    assert.equal(cfg.provider.anthropic.options, undefined);
    // Model id stored WITHOUT the anthropic/ prefix (provider key
    // already names the provider; opencode resolves <providerKey>/<modelID>)
    assert.ok(cfg.provider.anthropic.models?.["claude-opus-4-7"], "bare model id must be the key");
    assert.equal(cfg.provider.ollama, undefined, "no ollama block when only anthropic models supplied");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig — openai-prefixed model emits an openai provider block", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-cfg-"));
  try {
    const repos = new RepoService();
    await repos.writeOpencodeConfig(root, "openai/gpt-5");
    const cfg = JSON.parse(await fs.readFile(path.join(root, "opencode.json"), "utf8")) as {
      provider: Record<string, { npm?: string; models?: Record<string, unknown> }>;
    };
    assert.ok(cfg.provider.openai);
    assert.equal(cfg.provider.openai.npm, "@ai-sdk/openai");
    assert.ok(cfg.provider.openai.models?.["gpt-5"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig — unprefixed model still emits an ollama provider block (backward compat)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-cfg-"));
  try {
    const repos = new RepoService();
    await repos.writeOpencodeConfig(root, "glm-5.1:cloud");
    const cfg = JSON.parse(await fs.readFile(path.join(root, "opencode.json"), "utf8")) as {
      provider: Record<string, { npm?: string; options?: { baseURL?: string }; models?: Record<string, unknown> }>;
    };
    assert.ok(cfg.provider.ollama);
    assert.equal(cfg.provider.ollama.npm, "@ai-sdk/openai-compatible");
    assert.ok(cfg.provider.ollama.options?.baseURL, "baseURL preserved for ollama");
    assert.ok(cfg.provider.ollama.models?.["glm-5.1:cloud"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig — mixed provider input emits one block per provider", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-cfg-"));
  try {
    const repos = new RepoService();
    await repos.writeOpencodeConfig(root, [
      "glm-5.1:cloud",
      "anthropic/claude-opus-4-7",
      "openai/gpt-5",
    ]);
    const cfg = JSON.parse(await fs.readFile(path.join(root, "opencode.json"), "utf8")) as {
      provider: Record<string, { models?: Record<string, unknown> }>;
    };
    // All three providers present; each carries only its own models.
    assert.ok(cfg.provider.ollama?.models?.["glm-5.1:cloud"]);
    assert.ok(cfg.provider.anthropic?.models?.["claude-opus-4-7"]);
    assert.ok(cfg.provider.openai?.models?.["gpt-5"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unit 48: excludeRunnerArtifacts — append runner-written file patterns to
// the clone's local .git/info/exclude so they don't pollute `git status`.
// We test against synthetic .git/info/exclude files because spinning up a
// real git clone in a unit test is heavyweight (and unnecessary — the
// helper only knows about the file path, not git itself).
// ---------------------------------------------------------------------------

async function makeTmpClone(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-exclude-"));
  await fs.mkdir(path.join(root, ".git", "info"), { recursive: true });
  return root;
}

const EXPECTED_PATTERNS = [
  "opencode.json",
  "blackboard-state.json",
  "summary.json",
  "summary-*.json",
];

test("excludeRunnerArtifacts — appends every standard pattern to a fresh exclude file", async () => {
  const clone = await makeTmpClone();
  try {
    const repos = new RepoService();
    await repos.excludeRunnerArtifacts(clone);
    const content = await fs.readFile(path.join(clone, ".git", "info", "exclude"), "utf8");
    for (const pat of EXPECTED_PATTERNS) {
      assert.match(content, new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
    // Header comment is present (so a human reading the file knows where
    // these came from).
    assert.match(content, /Unit 48/);
  } finally {
    await fs.rm(clone, { recursive: true, force: true });
  }
});

test("excludeRunnerArtifacts — preserves existing exclude entries", async () => {
  const clone = await makeTmpClone();
  try {
    const excludePath = path.join(clone, ".git", "info", "exclude");
    await fs.writeFile(excludePath, "# user's prior entries\nmy-secrets.txt\nlocal.config\n", "utf8");
    const repos = new RepoService();
    await repos.excludeRunnerArtifacts(clone);
    const content = await fs.readFile(excludePath, "utf8");
    // Prior entries kept verbatim
    assert.match(content, /^my-secrets\.txt$/m);
    assert.match(content, /^local\.config$/m);
    // Our patterns appended after
    assert.match(content, /^opencode\.json$/m);
    assert.match(content, /^summary-\*\.json$/m);
  } finally {
    await fs.rm(clone, { recursive: true, force: true });
  }
});

test("excludeRunnerArtifacts — idempotent on repeat calls", async () => {
  const clone = await makeTmpClone();
  try {
    const repos = new RepoService();
    await repos.excludeRunnerArtifacts(clone);
    const after1 = await fs.readFile(path.join(clone, ".git", "info", "exclude"), "utf8");
    await repos.excludeRunnerArtifacts(clone);
    await repos.excludeRunnerArtifacts(clone);
    const after3 = await fs.readFile(path.join(clone, ".git", "info", "exclude"), "utf8");
    assert.equal(after3, after1, "second/third calls must not change the file");
  } finally {
    await fs.rm(clone, { recursive: true, force: true });
  }
});

test("excludeRunnerArtifacts — appends only the missing pattern when one already exists", async () => {
  const clone = await makeTmpClone();
  try {
    const excludePath = path.join(clone, ".git", "info", "exclude");
    // Prior content already has summary.json — only the OTHER patterns
    // should be appended.
    await fs.writeFile(excludePath, "summary.json\n", "utf8");
    const repos = new RepoService();
    await repos.excludeRunnerArtifacts(clone);
    const content = await fs.readFile(excludePath, "utf8");
    // summary.json appears exactly once (not duplicated)
    const summaryHits = content.match(/^summary\.json$/gm) ?? [];
    assert.equal(summaryHits.length, 1, "summary.json must not be duplicated");
    // The other patterns are appended
    assert.match(content, /^opencode\.json$/m);
    assert.match(content, /^blackboard-state\.json$/m);
  } finally {
    await fs.rm(clone, { recursive: true, force: true });
  }
});

test("excludeRunnerArtifacts — creates .git/info/ when missing (best-effort)", async () => {
  // Some shallow clones omit .git/info/ until git itself touches it.
  // Verify we recreate the dir + file rather than throwing.
  const clone = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-exclude-bare-"));
  try {
    await fs.mkdir(path.join(clone, ".git"), { recursive: true });
    // Note: NO .git/info/ subdir.
    const repos = new RepoService();
    await repos.excludeRunnerArtifacts(clone);
    const content = await fs.readFile(path.join(clone, ".git", "info", "exclude"), "utf8");
    assert.match(content, /^opencode\.json$/m);
  } finally {
    await fs.rm(clone, { recursive: true, force: true });
  }
});

test("excludeRunnerArtifacts — silently no-ops when .git is missing entirely", async () => {
  // No .git directory at all (clone failed, wrong path). Helper must
  // not throw — the runner's own clone error path will surface the
  // real failure.
  const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-exclude-norepo-"));
  try {
    const repos = new RepoService();
    await repos.excludeRunnerArtifacts(notARepo);
    // No assertion needed beyond "didn't throw" — but verify we
    // didn't accidentally CREATE .git out of thin air.
    let gitExists = true;
    try {
      await fs.access(path.join(notARepo, ".git"));
    } catch {
      gitExists = false;
    }
    assert.equal(gitExists, false, "must not create .git/ in a non-repo directory");
  } finally {
    await fs.rm(notARepo, { recursive: true, force: true });
  }
});

test("excludeRunnerArtifacts — handles existing exclude file without trailing newline", async () => {
  // A user's prior exclude file may end without a newline. The helper
  // must insert one before its appended block so the patterns aren't
  // glued to the previous line.
  const clone = await makeTmpClone();
  try {
    const excludePath = path.join(clone, ".git", "info", "exclude");
    await fs.writeFile(excludePath, "no-trailing-newline.txt", "utf8");
    const repos = new RepoService();
    await repos.excludeRunnerArtifacts(clone);
    const content = await fs.readFile(excludePath, "utf8");
    // Original entry stays intact on its own line
    assert.match(content, /^no-trailing-newline\.txt$/m);
    assert.match(content, /^opencode\.json$/m);
  } finally {
    await fs.rm(clone, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unit 47: cloneStats — used by clone() to populate the extended
// CloneResult so the runner can emit the clone_state SwarmEvent. We
// build a real tiny git repo on disk because cloneStats shells out via
// simple-git; mocking would defeat the purpose.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";

async function makeTmpGitRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-clonestats-"));
  // git init + config a placeholder identity so the test commits work
  // on hosts that don't have a global git config (CI in particular).
  execSync("git init -q -b main", { cwd: root });
  execSync("git config user.email test@example.com", { cwd: root });
  execSync("git config user.name Test", { cwd: root });
  return root;
}

test("cloneStats — returns commits=1 / clean tree on a fresh single-commit repo", async () => {
  const root = await makeTmpGitRepo();
  try {
    await fs.writeFile(path.join(root, "README.md"), "# Hello\n");
    execSync("git add README.md && git commit -q -m initial", { cwd: root });
    const repos = new RepoService();
    const stats = await repos.cloneStats(root);
    assert.equal(stats.commits, 1, "single commit");
    assert.equal(stats.changedFiles, 0, "clean tree");
    assert.equal(stats.untrackedFiles, 0, "no untracked");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloneStats — counts modified + untracked files separately", async () => {
  const root = await makeTmpGitRepo();
  try {
    await fs.writeFile(path.join(root, "tracked.md"), "v1\n");
    execSync("git add tracked.md && git commit -q -m v1", { cwd: root });
    // Modify the tracked file
    await fs.writeFile(path.join(root, "tracked.md"), "v2\n");
    // Add an untracked file
    await fs.writeFile(path.join(root, "fresh.md"), "new\n");
    const repos = new RepoService();
    const stats = await repos.cloneStats(root);
    assert.equal(stats.commits, 1);
    assert.equal(stats.changedFiles, 1, "tracked.md is modified");
    assert.equal(stats.untrackedFiles, 1, "fresh.md is untracked");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloneStats — counts multiple commits in history", async () => {
  const root = await makeTmpGitRepo();
  try {
    await fs.writeFile(path.join(root, "a.md"), "1\n");
    execSync("git add a.md && git commit -q -m c1", { cwd: root });
    await fs.writeFile(path.join(root, "b.md"), "2\n");
    execSync("git add b.md && git commit -q -m c2", { cwd: root });
    await fs.writeFile(path.join(root, "c.md"), "3\n");
    execSync("git add c.md && git commit -q -m c3", { cwd: root });
    const repos = new RepoService();
    const stats = await repos.cloneStats(root);
    assert.equal(stats.commits, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloneStats — returns zeros for a non-git directory (best-effort)", async () => {
  const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-clonestats-noregit-"));
  try {
    const repos = new RepoService();
    const stats = await repos.cloneStats(notARepo);
    // No throw, just zeros — the runner emits a clone_state with zero
    // counts and the UI knows not to show a "you have prior work"
    // banner because alreadyPresent will be false anyway.
    assert.equal(stats.commits, 0);
    assert.equal(stats.changedFiles, 0);
    assert.equal(stats.untrackedFiles, 0);
  } finally {
    await fs.rm(notARepo, { recursive: true, force: true });
  }
});
