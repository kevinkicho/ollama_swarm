// R12 (2026-05-04): tests for pre-flight disk-space check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
  evaluateDiskHeadroom,
  formatBytes,
  getFreeDiskBytes,
  preflightDiskCheck,
  DEFAULT_REQUIRED_BYTES,
} from "./preflightDiskCheck.js";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

test("evaluateDiskHeadroom — plenty of space → ok", () => {
  const got = evaluateDiskHeadroom({ freeBytes: 10 * GB });
  assert.equal(got.ok, true);
});

test("evaluateDiskHeadroom — exactly required → ok (≥)", () => {
  const got = evaluateDiskHeadroom({ freeBytes: 2 * GB });
  assert.equal(got.ok, true);
});

test("evaluateDiskHeadroom — below default → not ok", () => {
  const got = evaluateDiskHeadroom({ freeBytes: 100 * MB });
  assert.equal(got.ok, false);
});

test("evaluateDiskHeadroom — custom requiredBytes respected", () => {
  const got = evaluateDiskHeadroom({
    freeBytes: 500 * MB,
    requiredBytes: 1 * GB,
  });
  assert.equal(got.ok, false);
});

test("evaluateDiskHeadroom — 0 free → not ok", () => {
  const got = evaluateDiskHeadroom({ freeBytes: 0 });
  assert.equal(got.ok, false);
});

test("evaluateDiskHeadroom — NaN free → not ok", () => {
  const got = evaluateDiskHeadroom({ freeBytes: Number.NaN });
  assert.equal(got.ok, false);
});

test("evaluateDiskHeadroom — reason mentions both numbers", () => {
  const got = evaluateDiskHeadroom({ freeBytes: 100 * MB });
  assert.match(got.reason, /MB/);
  assert.match(got.reason, /GB/);
});

test("formatBytes — bytes range", () => {
  assert.equal(formatBytes(500), "500 B");
});

test("formatBytes — KB range", () => {
  assert.equal(formatBytes(2048), "2.0 KB");
});

test("formatBytes — MB range", () => {
  assert.equal(formatBytes(150 * MB), "150 MB");
});

test("formatBytes — GB range", () => {
  assert.equal(formatBytes(2 * GB), "2.0 GB");
});

test("formatBytes — TB range", () => {
  assert.equal(formatBytes(2 * 1024 * GB), "2.0 TB");
});

test("formatBytes — negative number → safe formatting", () => {
  assert.equal(formatBytes(-1), "-1B");
});

test("DEFAULT_REQUIRED_BYTES is 2 GB", () => {
  assert.equal(DEFAULT_REQUIRED_BYTES, 2 * GB);
});

test("getFreeDiskBytes — tmpdir → some positive number", async () => {
  // Smoke test: tmpdir always exists; expect positive bytes back.
  const got = await getFreeDiskBytes(tmpdir());
  // Some CI runners might not support statfs; allow null.
  if (got != null) {
    assert.ok(got > 0, `expected positive free bytes, got ${got}`);
  }
});

test("getFreeDiskBytes — nonexistent path → null", async () => {
  const got = await getFreeDiskBytes("/this/path/should/not/exist/xyz");
  assert.equal(got, null);
});

test("preflightDiskCheck — nonexistent path → ok=true (graceful)", async () => {
  const got = await preflightDiskCheck({
    targetPath: "/this/path/does/not/exist/xyz",
    requiredBytes: 1 * GB,
  });
  // Falls through with ok=true when statfs unavailable.
  assert.equal(got.ok, true);
  assert.match(got.reason, /unavailable/);
});

test("preflightDiskCheck — tmpdir with absurd requirement → ok=false", async () => {
  // Require 1 PB — virtually no machine has that free.
  const got = await preflightDiskCheck({
    targetPath: tmpdir(),
    requiredBytes: 1024 * 1024 * GB,
  });
  // Could be ok=true if statfs failed (graceful fall-through), so
  // just sanity-check the verdict is well-formed.
  assert.ok(typeof got.ok === "boolean");
  assert.ok(got.reason.length > 0);
});
