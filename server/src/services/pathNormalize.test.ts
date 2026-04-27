import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeWslPath } from "./pathNormalize.js";

// The function branches on `process.platform`. Tests need to exercise
// both branches without actually changing the host platform; we stub
// process.platform around each platform-sensitive test and restore it.
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

describe("normalizeWslPath — on Windows", () => {
  it("converts /mnt/c/<rest> to C:\\<rest>", () => {
    withPlatform("win32", () => {
      assert.equal(normalizeWslPath("/mnt/c/Users/kevin/Desktop"), "C:\\Users\\kevin\\Desktop");
    });
  });

  it("upper-cases the drive letter", () => {
    withPlatform("win32", () => {
      assert.equal(normalizeWslPath("/mnt/c/foo"), "C:\\foo");
      assert.equal(normalizeWslPath("/mnt/d/foo"), "D:\\foo");
      assert.equal(normalizeWslPath("/mnt/C/foo"), "C:\\foo");
    });
  });

  it("handles drive-only paths (no trailing slash)", () => {
    withPlatform("win32", () => {
      assert.equal(normalizeWslPath("/mnt/c"), "C:\\");
    });
  });

  it("handles drive with bare trailing slash", () => {
    withPlatform("win32", () => {
      assert.equal(normalizeWslPath("/mnt/c/"), "C:\\");
    });
  });

  it("preserves nested path segments + handles empty in-between segments", () => {
    withPlatform("win32", () => {
      assert.equal(
        normalizeWslPath("/mnt/c/Users/kevin/Desktop/ollama_swarm/runs"),
        "C:\\Users\\kevin\\Desktop\\ollama_swarm\\runs",
      );
    });
  });

  it("does NOT convert /mnt/<multi-char>/... (not a WSL drive shape)", () => {
    withPlatform("win32", () => {
      assert.equal(normalizeWslPath("/mnt/cc/foo"), "/mnt/cc/foo");
      assert.equal(normalizeWslPath("/mnt/sda1/foo"), "/mnt/sda1/foo");
    });
  });

  it("does NOT convert non-WSL Linux paths", () => {
    withPlatform("win32", () => {
      assert.equal(normalizeWslPath("/home/kevin/work"), "/home/kevin/work");
      assert.equal(normalizeWslPath("/etc/hosts"), "/etc/hosts");
      assert.equal(normalizeWslPath("/tmp"), "/tmp");
    });
  });

  it("does NOT convert paths that already look Windows", () => {
    withPlatform("win32", () => {
      assert.equal(normalizeWslPath("C:\\Users\\kevin"), "C:\\Users\\kevin");
      assert.equal(normalizeWslPath("D:/foo/bar"), "D:/foo/bar");
    });
  });

  it("does NOT convert UNC paths", () => {
    withPlatform("win32", () => {
      assert.equal(normalizeWslPath("\\\\server\\share\\foo"), "\\\\server\\share\\foo");
    });
  });

  it("does NOT convert relative paths", () => {
    withPlatform("win32", () => {
      assert.equal(normalizeWslPath("relative/foo"), "relative/foo");
      assert.equal(normalizeWslPath("./foo"), "./foo");
      assert.equal(normalizeWslPath("../foo"), "../foo");
    });
  });

  it("does NOT convert /mnt alone (no drive)", () => {
    withPlatform("win32", () => {
      assert.equal(normalizeWslPath("/mnt"), "/mnt");
      assert.equal(normalizeWslPath("/mnt/"), "/mnt/");
    });
  });
});

describe("normalizeWslPath — on non-Windows", () => {
  it("is a no-op on linux even for WSL-shaped inputs", () => {
    withPlatform("linux", () => {
      assert.equal(normalizeWslPath("/mnt/c/Users/foo"), "/mnt/c/Users/foo");
    });
  });

  it("is a no-op on darwin", () => {
    withPlatform("darwin", () => {
      assert.equal(normalizeWslPath("/mnt/c/foo"), "/mnt/c/foo");
      assert.equal(normalizeWslPath("/Users/kevin/work"), "/Users/kevin/work");
    });
  });

  it("preserves Windows-shaped paths on linux unchanged (passthrough)", () => {
    withPlatform("linux", () => {
      assert.equal(normalizeWslPath("C:\\Users\\foo"), "C:\\Users\\foo");
    });
  });
});
