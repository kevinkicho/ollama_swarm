import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./writeFileAtomic.js";

let tmpRoot: string;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-wfa-"));
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("creates a new file with the given contents", async () => {
    const target = path.join(tmpRoot, "a.txt");
    await writeFileAtomic(target, "hello");
    const got = await fs.readFile(target, "utf8");
    assert.equal(got, "hello");
  });

  it("overwrites an existing file atomically (no tmp file left behind)", async () => {
    const target = path.join(tmpRoot, "b.txt");
    await fs.writeFile(target, "old");
    await writeFileAtomic(target, "new");
    const got = await fs.readFile(target, "utf8");
    assert.equal(got, "new");
    const entries = await fs.readdir(tmpRoot);
    const leftovers = entries.filter((e) => e.startsWith("b.txt.swarm-tmp-"));
    assert.deepEqual(leftovers, []);
  });

  it("creates missing parent directories", async () => {
    const target = path.join(tmpRoot, "nested", "deeper", "c.txt");
    await writeFileAtomic(target, "deep");
    const got = await fs.readFile(target, "utf8");
    assert.equal(got, "deep");
  });

  it("writes utf-8 without BOM even when the string starts with U+FEFF literal bytes", async () => {
    // Sanity: the helper passes the string through as-is. BOM rejection is
    // a higher-layer concern (Step D); this test just pins the encoding.
    const target = path.join(tmpRoot, "d.txt");
    await writeFileAtomic(target, "﻿hi");
    const bytes = await fs.readFile(target);
    // First three bytes of UTF-8 encoded FEFF are EF BB BF.
    assert.equal(bytes[0], 0xef);
    assert.equal(bytes[1], 0xbb);
    assert.equal(bytes[2], 0xbf);
  });
});
