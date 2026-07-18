import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveHostShell, resetHostShellCache } from "./hostShell.js";

describe("resolveHostShell", () => {
  beforeEach(() => {
    resetHostShellCache();
    delete process.env.SWARM_HOST_SHELL;
  });

  it("honors SWARM_HOST_SHELL=cmd on win32", () => {
    if (process.platform !== "win32") return;
    process.env.SWARM_HOST_SHELL = "cmd";
    resetHostShellCache();
    const h = resolveHostShell();
    assert.equal(h.kind, "cmd");
    assert.equal(h.mode, "shell");
  });

  it("returns a labeled host shell", () => {
    const h = resolveHostShell();
    assert.ok(h.label.length > 0);
    assert.ok(["pwsh", "cmd", "sh"].includes(h.kind));
  });
});
