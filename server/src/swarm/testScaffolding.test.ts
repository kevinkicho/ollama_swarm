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
