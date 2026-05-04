// T199 (2026-05-04): tests for the test-scaffolding generator
// helper. Pure-function coverage for buildScaffold + on-disk
// roundtrip for detectTestFramework + scaffoldTestForTopic.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildScaffold,
  detectTestFramework,
  scaffoldTestForTopic,
} from "./testScaffolding.js";

describe("buildScaffold — pure", () => {
  it("emits vitest stub with expect.fail for the topic", () => {
    const out = buildScaffold("vitest", "fix-off-by-one", "test/fix-off-by-one.test.ts");
    assert.match(out.stubContent, /from "vitest"/);
    assert.match(out.stubContent, /describe\("fix-off-by-one"/);
    assert.match(out.stubContent, /expect\.fail/);
    assert.equal(out.verifyCommand, "npx vitest run test/fix-off-by-one.test.ts");
  });

  it("emits jest stub with throw new Error for the topic", () => {
    const out = buildScaffold("jest", "add-bcrypt", "test/add-bcrypt.test.ts");
    assert.match(out.stubContent, /describe\("add-bcrypt"/);
    assert.match(out.stubContent, /throw new Error/);
    assert.equal(out.verifyCommand, "npx jest test/add-bcrypt.test.ts");
  });

  it("emits bun-test stub with bun:test import", () => {
    const out = buildScaffold("bun-test", "topic", "test/topic.test.ts");
    assert.match(out.stubContent, /from "bun:test"/);
    assert.equal(out.verifyCommand, "bun test test/topic.test.ts");
  });

  it("emits node-test stub with node:test + assert.fail", () => {
    const out = buildScaffold("node-test", "topic", "test/topic.test.ts");
    assert.match(out.stubContent, /from "node:test"/);
    assert.match(out.stubContent, /assert\.fail/);
    assert.match(out.verifyCommand, /node --import tsx --test/);
  });

  it("falls back to node-test for unknown framework", () => {
    const out = buildScaffold("unknown" as never, "topic", "test/topic.test.ts");
    assert.match(out.stubContent, /from "node:test"/);
  });

  it("slugifies topic for the test name", () => {
    const out = buildScaffold("vitest", "Add Bcrypt Hashing!", "test/x.test.ts");
    assert.match(out.stubContent, /Add_Bcrypt_Hashing/);
  });
});

describe("detectTestFramework — on-disk", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "scaffold-detect-"));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("returns 'vitest' when devDependencies has vitest", async () => {
    writeFileSync(
      join(workdir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }),
    );
    assert.equal(await detectTestFramework(workdir), "vitest");
  });

  it("returns 'jest' when devDependencies has jest", async () => {
    writeFileSync(
      join(workdir, "package.json"),
      JSON.stringify({ devDependencies: { jest: "^29.0.0" } }),
    );
    assert.equal(await detectTestFramework(workdir), "jest");
  });

  it("returns 'bun-test' when @types/bun present", async () => {
    writeFileSync(
      join(workdir, "package.json"),
      JSON.stringify({ devDependencies: { "@types/bun": "*" } }),
    );
    assert.equal(await detectTestFramework(workdir), "bun-test");
  });

  it("returns 'node-test' when scripts use --test", async () => {
    writeFileSync(
      join(workdir, "package.json"),
      JSON.stringify({ scripts: { test: "node --test src/**/*.test.ts" } }),
    );
    assert.equal(await detectTestFramework(workdir), "node-test");
  });

  it("returns 'vitest' when vitest.config.ts present (no dep)", async () => {
    writeFileSync(join(workdir, "package.json"), "{}");
    writeFileSync(join(workdir, "vitest.config.ts"), "export default {};");
    assert.equal(await detectTestFramework(workdir), "vitest");
  });

  it("returns 'unknown' when nothing matches", async () => {
    writeFileSync(join(workdir, "package.json"), "{}");
    assert.equal(await detectTestFramework(workdir), "unknown");
  });

  it("returns 'unknown' when no package.json", async () => {
    assert.equal(await detectTestFramework(workdir), "unknown");
  });
});

describe("scaffoldTestForTopic — on-disk integration", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "scaffold-int-"));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("returns null for empty topic", async () => {
    const out = await scaffoldTestForTopic({ clonePath: workdir, topic: "  " });
    assert.equal(out, null);
  });

  it("falls back to node-test when framework unknown + fallback enabled", async () => {
    writeFileSync(join(workdir, "package.json"), "{}");
    const out = await scaffoldTestForTopic({
      clonePath: workdir,
      topic: "fix-X",
    });
    assert.ok(out);
    assert.equal(out!.framework, "node-test");
  });

  it("returns null when framework unknown + fallback disabled", async () => {
    writeFileSync(join(workdir, "package.json"), "{}");
    const out = await scaffoldTestForTopic({
      clonePath: workdir,
      topic: "fix-X",
      fallbackToNodeTest: false,
    });
    assert.equal(out, null);
  });

  it("prefers existing test/ dir over fallback", async () => {
    writeFileSync(join(workdir, "package.json"), "{}");
    mkdirSync(join(workdir, "tests"));
    const out = await scaffoldTestForTopic({
      clonePath: workdir,
      topic: "topic",
    });
    assert.ok(out);
    assert.match(out!.suggestedTestPath, /^tests\//);
  });

  it("respects forceFramework override", async () => {
    writeFileSync(join(workdir, "package.json"), "{}");
    const out = await scaffoldTestForTopic({
      clonePath: workdir,
      topic: "topic",
      forceFramework: "vitest",
    });
    assert.ok(out);
    assert.equal(out!.framework, "vitest");
    assert.match(out!.stubContent, /from "vitest"/);
  });
});

// T-Item-Lang (2026-05-04): Python/Rust/Go scaffolding
describe("buildScaffold — Python/Rust/Go (T-Item-Lang)", () => {
  it("pytest stub uses pytest.fail + module-style import", () => {
    const out = buildScaffold("pytest", "add-bcrypt", "tests/test_add_bcrypt.py");
    assert.match(out.stubContent, /import pytest/);
    assert.match(out.stubContent, /def test_add_bcrypt_placeholder/);
    assert.match(out.stubContent, /pytest\.fail/);
    assert.equal(out.verifyCommand, "pytest -x tests/test_add_bcrypt.py");
  });

  it("unittest stub uses TestCase + self.fail", () => {
    const out = buildScaffold("unittest", "fix-bug", "tests/test_fix_bug.py");
    assert.match(out.stubContent, /import unittest/);
    assert.match(out.stubContent, /class TestFixBug\(unittest\.TestCase\)/);
    assert.match(out.stubContent, /self\.fail/);
    assert.match(out.verifyCommand, /python -m unittest /);
  });

  it("cargo-test stub uses #[test] + panic!", () => {
    const out = buildScaffold("cargo-test", "topic", "tests/topic_test.rs");
    assert.match(out.stubContent, /#\[cfg\(test\)\]/);
    assert.match(out.stubContent, /#\[test\]/);
    assert.match(out.stubContent, /fn topic_placeholder\(\)/);
    assert.match(out.stubContent, /panic!/);
    assert.match(out.verifyCommand, /^cargo test --test topic_test /);
  });

  it("go-test stub uses *testing.T + t.Fatal", () => {
    const out = buildScaffold("go-test", "fix-thing", "internal/foo/fix_thing_test.go");
    assert.match(out.stubContent, /package foo_test/);
    assert.match(out.stubContent, /import \(\n\t"testing"/);
    assert.match(out.stubContent, /func TestFixThingPlaceholder/);
    assert.match(out.stubContent, /t\.Fatal/);
    assert.match(out.verifyCommand, /^go test -run "TestFixThingPlaceholder" \.\/internal\/foo$/);
  });
});

describe("detectTestFramework — Python/Rust/Go (T-Item-Lang)", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "swarm-tsf-lang-"));
  });
  afterEach(() => rmSync(workdir, { recursive: true, force: true }));

  it("pyproject.toml mentioning pytest → pytest", async () => {
    writeFileSync(join(workdir, "pyproject.toml"), `[project]\nname = "x"\n[tool.pytest]`);
    assert.equal(await detectTestFramework(workdir), "pytest");
  });

  it("pyproject.toml mentioning unittest → unittest", async () => {
    writeFileSync(
      join(workdir, "pyproject.toml"),
      `[project]\nname = "x"\ndescription = "uses unittest"`,
    );
    assert.equal(await detectTestFramework(workdir), "unittest");
  });

  it("pyproject.toml with neither → defaults to pytest (modern convention)", async () => {
    writeFileSync(join(workdir, "pyproject.toml"), `[project]\nname = "x"`);
    assert.equal(await detectTestFramework(workdir), "pytest");
  });

  it("requirements.txt with pytest → pytest", async () => {
    writeFileSync(join(workdir, "requirements.txt"), `pytest>=7\nrequests\n`);
    assert.equal(await detectTestFramework(workdir), "pytest");
  });

  it("setup.py with pytest → pytest", async () => {
    writeFileSync(join(workdir, "setup.py"), `from setuptools import setup\nsetup(tests_require=['pytest'])`);
    assert.equal(await detectTestFramework(workdir), "pytest");
  });

  it("tests/ dir with .py files → pytest (probe-based)", async () => {
    mkdirSync(join(workdir, "tests"));
    writeFileSync(join(workdir, "tests", "test_x.py"), `def test_x(): pass`);
    assert.equal(await detectTestFramework(workdir), "pytest");
  });

  it("Cargo.toml present → cargo-test", async () => {
    writeFileSync(join(workdir, "Cargo.toml"), `[package]\nname = "x"\nversion = "0.1.0"`);
    assert.equal(await detectTestFramework(workdir), "cargo-test");
  });

  it("go.mod present → go-test", async () => {
    writeFileSync(join(workdir, "go.mod"), `module example.com/x\n\ngo 1.21\n`);
    assert.equal(await detectTestFramework(workdir), "go-test");
  });

  it("JS package.json takes precedence over Python markers", async () => {
    writeFileSync(
      join(workdir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^1.0" } }),
    );
    writeFileSync(join(workdir, "pyproject.toml"), `[project]\nname = "x"`);
    assert.equal(await detectTestFramework(workdir), "vitest");
  });

  it("returns 'unknown' on truly empty repo", async () => {
    assert.equal(await detectTestFramework(workdir), "unknown");
  });
});

describe("scaffoldTestForTopic — Python/Rust/Go path conventions (T-Item-Lang)", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "swarm-tsf-lang-int-"));
  });
  afterEach(() => rmSync(workdir, { recursive: true, force: true }));

  it("pytest path → tests/test_<slug>.py", async () => {
    mkdirSync(join(workdir, "tests"));
    writeFileSync(join(workdir, "tests", "test_x.py"), "");
    const out = await scaffoldTestForTopic({
      clonePath: workdir,
      topic: "Add Bcrypt",
    });
    assert.ok(out);
    assert.equal(out!.framework, "pytest");
    assert.match(out!.suggestedTestPath, /^tests\/test_Add-Bcrypt\.py$|^tests\/test_add-bcrypt\.py$/);
  });

  it("cargo-test path → tests/<slug>_test.rs", async () => {
    writeFileSync(join(workdir, "Cargo.toml"), `[package]\nname = "x"\nversion = "0.1.0"`);
    const out = await scaffoldTestForTopic({
      clonePath: workdir,
      topic: "fix-bug",
    });
    assert.ok(out);
    assert.equal(out!.framework, "cargo-test");
    assert.match(out!.suggestedTestPath, /^tests\/fix-bug_test\.rs$/);
  });

  it("go-test path → <slug>_test.go", async () => {
    writeFileSync(join(workdir, "go.mod"), `module example.com/x`);
    const out = await scaffoldTestForTopic({
      clonePath: workdir,
      topic: "fix-thing",
    });
    assert.ok(out);
    assert.equal(out!.framework, "go-test");
    assert.match(out!.suggestedTestPath, /_test\.go$/);
  });
});
