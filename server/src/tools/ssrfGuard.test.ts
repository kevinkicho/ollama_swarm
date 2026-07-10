import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBlockedWebFetchUrl } from "./ssrfGuard.js";

describe("isBlockedWebFetchUrl", () => {
  it("allows public https URLs", () => {
    assert.equal(isBlockedWebFetchUrl("https://example.com/path").blocked, false);
  });

  it("blocks localhost and loopback", () => {
    assert.equal(isBlockedWebFetchUrl("http://localhost/x").blocked, true);
    assert.equal(isBlockedWebFetchUrl("http://127.0.0.1/x").blocked, true);
    assert.equal(isBlockedWebFetchUrl("http://[::1]/").blocked, true);
  });

  it("blocks private RFC1918 ranges", () => {
    assert.equal(isBlockedWebFetchUrl("http://10.0.0.5/").blocked, true);
    assert.equal(isBlockedWebFetchUrl("http://192.168.1.1/").blocked, true);
    assert.equal(isBlockedWebFetchUrl("http://172.16.0.1/").blocked, true);
  });

  it("blocks cloud metadata hostname", () => {
    assert.equal(isBlockedWebFetchUrl("http://metadata.google.internal/").blocked, true);
  });

  it("blocks non-http schemes", () => {
    assert.equal(isBlockedWebFetchUrl("file:///etc/passwd").blocked, true);
  });
});
