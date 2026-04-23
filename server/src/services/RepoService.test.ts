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

test("writeOpencodeConfig — swarm profile has ALL tools disabled (blackboard worker safety)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-cfg-"));
  try {
    const repos = new RepoService();
    await repos.writeOpencodeConfig(root, "test-model");
    const cfg = JSON.parse(await fs.readFile(path.join(root, "opencode.json"), "utf8")) as {
      agent: Record<string, { tools: Record<string, boolean> }>;
    };
    const tools = cfg.agent["swarm"].tools;
    for (const [name, enabled] of Object.entries(tools)) {
      assert.equal(enabled, false, `swarm.tools.${name} must be false (blackboard workers must not use tools — they return JSON diffs)`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig — swarm-read enables read tools, denies write/edit/bash", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-cfg-"));
  try {
    const repos = new RepoService();
    await repos.writeOpencodeConfig(root, "test-model");
    const cfg = JSON.parse(await fs.readFile(path.join(root, "opencode.json"), "utf8")) as {
      agent: Record<string, { tools: Record<string, boolean>; permission?: Record<string, string> }>;
    };
    const profile = cfg.agent["swarm-read"];
    // Read-side: should be ON
    assert.equal(profile.tools.read, true, "swarm-read.tools.read must be true");
    assert.equal(profile.tools.grep, true, "swarm-read.tools.grep must be true");
    assert.equal(profile.tools.glob, true, "swarm-read.tools.glob must be true");
    // Write-side: must stay OFF (the safety property)
    assert.equal(profile.tools.write, false, "swarm-read.tools.write must be false (discussion-only)");
    assert.equal(profile.tools.edit, false, "swarm-read.tools.edit must be false (discussion-only)");
    assert.equal(profile.tools.bash, false, "swarm-read.tools.bash must be false (discussion-only)");
    // Belt-and-suspenders permission deny
    assert.equal(profile.permission?.edit, "deny");
    assert.equal(profile.permission?.bash, "deny");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
