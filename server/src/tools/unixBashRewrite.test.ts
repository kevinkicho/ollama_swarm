import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { tryFulfillUnixBashViaTools } from "./nativeToolHandlers.js";

describe("tryFulfillUnixBashViaTools", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-unix-rw-"));
    await fs.writeFile(
      path.join(tmp, "sample.txt"),
      "one\ntwo\nthree words here\n",
      "utf8",
    );
  });

  after(async () => {
    try {
      await fs.rm(tmp, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("rewrites wc -l FILE", async () => {
    const r = await tryFulfillUnixBashViaTools(tmp, "wc -l sample.txt");
    assert.ok(r?.ok);
    assert.match(r!.output ?? "", /^3\t/);
  });

  it("rewrites bare wc FILE (line word byte)", async () => {
    const r = await tryFulfillUnixBashViaTools(tmp, "wc sample.txt");
    assert.ok(r?.ok);
    // 3 lines, 5 words (one two three words here), bytes > 0
    assert.match(r!.output ?? "", /^3 5 \d+\t/);
  });

  it("rewrites tail -n 2 FILE", async () => {
    const r = await tryFulfillUnixBashViaTools(tmp, "tail -n 2 sample.txt");
    assert.ok(r?.ok);
    assert.equal((r!.output ?? "").trim(), "two\nthree words here");
  });

  it("chains cat && wc -l", async () => {
    const r = await tryFulfillUnixBashViaTools(tmp, "cat sample.txt && wc -l sample.txt");
    assert.ok(r?.ok);
    assert.match(r!.output ?? "", /one/);
    assert.match(r!.output ?? "", /3\t/);
  });

  it("returns null for pipes (not rewritten)", async () => {
    const r = await tryFulfillUnixBashViaTools(tmp, "cat sample.txt | wc -l");
    assert.equal(r, null);
  });
});
