import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractUrlsFromToolTrace,
  formatToolInvokePreview,
  makeBufferedToolHandler,
  peekPendingToolTrace,
  takePendingToolTrace,
} from "./toolCallTranscript.js";

test("formatToolInvokePreview includes args when glob returns no matches", () => {
  const preview = formatToolInvokePreview(
    "glob",
    { pattern: "**/*.xyz" },
    { ok: true, output: "(no files matched pattern: **/*.xyz)" },
  );
  assert.match(preview, /\*\*\/\*\.xyz/);
  assert.match(preview, /no files matched|→/);
});

test("formatToolInvokePreview labels empty successful output", () => {
  const preview = formatToolInvokePreview("glob", { pattern: "missing.ts" }, { ok: true, output: "" });
  assert.equal(preview, "missing.ts → (no output)");
});

test("formatToolInvokePreview includes error text", () => {
  const preview = formatToolInvokePreview(
    "read",
    { path: "../escape.txt" },
    { ok: false, error: "path escapes clone root" },
  );
  assert.match(preview, /escape\.txt/);
  assert.match(preview, /path escapes/);
});

test("makeBufferedToolHandler attaches trace to next agent bubble", () => {
  const pending = new Map<string, import("./toolCallTranscript.js").ToolTraceEntry[]>();
  const onTool = makeBufferedToolHandler(pending, "agent-2");
  onTool({ tool: "read", ok: true, preview: "requirements.txt → pytest" });
  onTool({ tool: "grep", ok: false, preview: "ENOTDIR" });
  const trace = takePendingToolTrace(pending, "agent-2");
  assert.equal(trace?.length, 2);
  assert.equal(trace?.[0]?.tool, "read");
  assert.equal(trace?.[1]?.ok, false);
  assert.equal(takePendingToolTrace(pending, "agent-2"), undefined);
});

test("extractUrlsFromToolTrace pulls https from web_fetch/web_search previews", () => {
  const urls = extractUrlsFromToolTrace([
    {
      tool: "web_fetch",
      ok: true,
      preview: "https://api.stlouisfed.org/fred → FRED docs body…",
      ts: 1,
    },
    {
      tool: "web_search",
      ok: true,
      preview:
        "Web search results for: x\nhttps://stats.bis.org/api\nhttps://example.com/skip",
      ts: 2,
    },
    { tool: "read", ok: true, preview: "src/a.ts → code", ts: 3 },
  ]);
  assert.ok(urls.includes("https://api.stlouisfed.org/fred"));
  assert.ok(urls.includes("https://stats.bis.org/api"));
  assert.ok(!urls.some((u) => u.includes("example.com")));
});

test("peekPendingToolTrace is non-destructive", () => {
  const pending = new Map<string, import("./toolCallTranscript.js").ToolTraceEntry[]>();
  const onTool = makeBufferedToolHandler(pending, "a1");
  onTool({ tool: "web_fetch", ok: true, preview: "https://imf.org/data → ok" });
  assert.equal(peekPendingToolTrace(pending, "a1").length, 1);
  assert.equal(peekPendingToolTrace(pending, "a1").length, 1);
  assert.equal(takePendingToolTrace(pending, "a1")?.length, 1);
  assert.equal(peekPendingToolTrace(pending, "a1").length, 0);
});
