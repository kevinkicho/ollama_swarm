import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  loadEndpointCatalogSnapshot,
  renderEndpointCatalogBlock,
  todoTouchesApiSurface,
} from "./endpointCatalogContext.js";

describe("todoTouchesApiSurface", () => {
  it("detects API-related descriptions", () => {
    assert.equal(todoTouchesApiSurface("Add BoE proxy route", ["x.js"]), true);
  });

  it("detects route file targets", () => {
    assert.equal(
      todoTouchesApiSurface("registry", ["functions/src/routes/boe.js"]),
      true,
    );
  });

  it("returns false for unrelated todos", () => {
    assert.equal(todoTouchesApiSurface("Fix typo in README", ["README.md"]), false);
  });
});

describe("loadEndpointCatalogSnapshot", () => {
  it("reads catalog and env keys", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "endpoint-catalog-"));
    try {
      await writeFile(
        path.join(dir, "API_ENDPOINTS.md"),
        "| Provider | URL |\n| BEA | /api/bea |",
        "utf8",
      );
      await writeFile(
        path.join(dir, ".env.example"),
        "# keys\nBEA_API_KEY=\nFRED_API_KEY=\nPORT=3000\n",
        "utf8",
      );
      const snap = await loadEndpointCatalogSnapshot(dir);
      assert.ok(snap);
      assert.equal(snap!.catalogPath, "API_ENDPOINTS.md");
      assert.ok(snap!.envKeys.includes("BEA_API_KEY"));
      const block = renderEndpointCatalogBlock(snap!);
      assert.match(block, /do NOT add duplicates/);
      assert.match(block, /BEA_API_KEY/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});