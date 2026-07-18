import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMcpServerSpecs, mcpSpawnEnvForCmd } from "./mcpServerSpecs.js";

describe("parseMcpServerSpecs", () => {
  it("keeps npx -y package as one command (the open-websearch form)", () => {
    const specs = parseMcpServerSpecs("search=npx -y open-websearch@latest");
    assert.equal(specs.length, 1);
    assert.deepEqual(specs[0], {
      key: "search",
      command: "npx",
      args: ["-y", "open-websearch@latest"],
      rawCmd: "npx -y open-websearch@latest",
    });
  });

  it("does not split on spaces the way the old bug did", () => {
    // Old: split(/[\s,]+/) → ["search=npx", "-y", "open-websearch@latest"]
    const broken = "search=npx -y open-websearch@latest"
      .split(/[\s,]+/)
      .filter(Boolean);
    assert.equal(broken.length, 3, "documents the old bug shape");
    const fixed = parseMcpServerSpecs("search=npx -y open-websearch@latest");
    assert.equal(fixed.length, 1);
    assert.equal(fixed[0]!.args.length, 2);
  });

  it("supports multiple servers separated by semicolon", () => {
    const specs = parseMcpServerSpecs(
      "search=npx -y open-websearch@latest; other=npx -y foo@1",
    );
    assert.equal(specs.length, 2);
    assert.equal(specs[0]!.key, "search");
    assert.equal(specs[1]!.key, "other");
    assert.deepEqual(specs[1]!.args, ["-y", "foo@1"]);
  });

  it("supports newline-separated specs", () => {
    const specs = parseMcpServerSpecs(
      "search=npx -y open-websearch@latest\nplay=npx -y @playwright/mcp",
    );
    assert.equal(specs.length, 2);
    assert.equal(specs[1]!.key, "play");
  });
});

describe("mcpSpawnEnvForCmd", () => {
  it("sets MODE=stdio for open-websearch when unset", () => {
    const env = mcpSpawnEnvForCmd("npx -y open-websearch@latest", {
      PATH: "/usr/bin",
    });
    assert.equal(env.MODE, "stdio");
  });

  it("does not override an existing MODE", () => {
    const env = mcpSpawnEnvForCmd("npx -y open-websearch@latest", {
      MODE: "http",
    });
    assert.equal(env.MODE, "http");
  });
});
