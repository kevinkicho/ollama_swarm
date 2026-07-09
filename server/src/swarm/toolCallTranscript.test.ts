import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatToolInvokePreview,
  makeBufferedToolHandler,
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