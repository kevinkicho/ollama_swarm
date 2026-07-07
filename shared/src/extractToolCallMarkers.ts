// Extract XML-style tool-call markers from agent text.
//
// Some models (notably glm-5.1, sometimes deepseek) emit raw XML
// pseudo-tool-calls in their text response when they THINK they're
// invoking SDK tool functions. Examples observed in production:
//   <read path='src/foo.ts' start_line='1' end_line='100'>
//   <grep path='src/' pattern='retry|backoff'>
//   <list>src/</list>
//   <glob>src/**/*.test.ts</glob>
//   <edit>src/foo.ts</edit>
//   <bash>npm test</bash>
//
// These are model HALLUCINATIONS — the model never actually invoked a
// tool. They leak into the visible bubble as raw text, often dozens of
// lines per agent turn, and they cause two cascading problems:
//
// 1. **Parse failures**: when the marker prefix wraps a JSON envelope
//    (contract / todos), JSON.parse fails on the leading "<". The
//    parser emits a repair prompt, doubling the cost of the turn.
//
// 2. **Phase 2 over-segmentation**: each marker is followed by `\n\n`,
//    triggering a paragraph-break boundary in useSegmentSplitter and
//    fragmenting the bubble into 20-30 micro-segments per turn.
//
// 3. **Planner work blocked**: when these markers wrap an empty/garbage
//    todos array, the run exits as no-progress (RCA: preset 1, run
//    af27f55c, 2026-04-27 evening).
//
// This extractor strips them server-side at appendAgent time. The
// client renders them as a collapsed-by-default ToolCallsBlock similar
// to ThoughtsBlock — the user can see what the planner THOUGHT it was
// reading without that text bloating the bubble.
//
// Pure shape-transform: text in → { toolCalls, finalText } out. No I/O.

const MARKER_TAGS = [
  "read",
  "read_file",
  "grep",
  "grep_file",
  "list",
  "list_directory",
  "list_files",
  "glob",
  "glob_files",
  "edit",
  "edit_file",
  "bash",
  "bash_command",
  "execute_command",
  "run_command",
  "write",
  "write_file",
  "create_file",
  "delete_file",
  "search",
  "search_content",
  "find",
  "tree",
  "ls",
  "cat",
  // #292 (2026-04-28): MCP-style tool-call wrappers. The blackboard
  // tour run 3c4a2da1 surfaced 100+ raw `<tool_use><server_name>...
  // </server_name><tool_name>read_file</tool_name><arguments>...
  // </arguments></tool_use>` blocks from the planner. Same hallucination
  // shape as the bare-XML markers above, just nested. The PAIRED_TAG_RE
  // catches the outer wrapper and `[\s\S]*?` consumes the nested
  // children as content, so adding the wrapper tag is sufficient.
  // function_call + invoke cover GPT/Claude-flavored equivalents seen
  // in stripToolCallLeak's marker list (server/src/swarm/extractText.ts
  // lines 113-118) so the two extraction layers stay aligned.
  "tool_use",
  "tool_call",
  "function_call",
  "invoke",
] as const;

// Match an XML-style tag at any position. Handles:
//   - self-closing: <read path='x' />
//   - paired:       <list>src/</list>
//   - attributes:   <read path='src/foo.ts' start_line='1' end_line='100'>
// Permissive on attribute quoting (single/double) and whitespace.
//
// We DO NOT validate that the tag actually closes — the model's intent
// is clearly tool-invocation regardless of whether it bothered to close.
// A bare `<read path='x' end='y'>` is treated the same as `<read .../>`.
const TAG_ALTERNATION = MARKER_TAGS.join("|");
const SINGLE_TAG_RE = new RegExp(
  `<(${TAG_ALTERNATION})\\b([^>]*?)(?:\\s*/\\s*)?>`,
  "gi",
);
const PAIRED_TAG_RE = new RegExp(
  `<(${TAG_ALTERNATION})\\b([^>]*?)>([\\s\\S]*?)</\\1>`,
  "gi",
);

// DeepSeek v4 explore turns emit nested <function> wrappers instead of bare
// <read path='...'/> markers. Observed in blackboard run 94224a3e (2026-07-07):
//   <function>
//   <function name>read</function>
//   <parameter name="path">C:\...\GOVERNMENT_API_CATALOG.md</parameter>
//   </function>
// Must match the full outer wrapper; a naive non-greedy </function> stops at the
// inner <function name>…</function> child (run 94224a3e).
const DEEPSEEK_FUNCTION_BLOCK_RE =
  /<function>\s*<function\s+name>[^<]+<\/function>\s*<parameter\s+name=["'][^"']+["']>[^<]*<\/parameter>\s*<\/function>/gi;

/**
 * Split agent text into tool-call markers + the rest.
 *
 * Behavior:
 *  - Paired forms (`<list>...</list>`) consumed first, content captured.
 *  - Single-tag forms (`<read .../>` or unclosed openers) consumed next.
 *  - Markers are joined into the toolCalls array as their original raw text.
 *  - finalText has them removed; whitespace collapsed (3+ newlines → 2).
 *  - When extraction empties everything, return original text as finalText
 *    (mirror extractThinkTags fallback) so the bubble renders SOMETHING.
 *  - No markers detected → toolCalls=[], finalText=input verbatim.
 */
export function extractToolCallMarkers(text: string): {
  toolCalls: string[];
  finalText: string;
} {
  if (!text) return { toolCalls: [], finalText: text };
  // Fast path: cheap precheck before the regex engine.
  if (!text.includes("<")) return { toolCalls: [], finalText: text };

  const toolCalls: string[] = [];
  const pushMarker = (match: string) => {
    // Collapse consecutive duplicates — models often re-emit the same
    // pseudo-marker hundreds of times in a stream loop (#4f136068).
    if (toolCalls.length === 0 || toolCalls[toolCalls.length - 1] !== match) {
      toolCalls.push(match);
    }
  };

  // Pass 0: DeepSeek <function>...</function> wrappers (before bare XML tags).
  let stripped = text.replace(DEEPSEEK_FUNCTION_BLOCK_RE, (match) => {
    pushMarker(match);
    return "";
  });

  // Pass 1: paired tags. The full tag-match (including content) gets
  // recorded; the content stays inside the tool-call entry so the
  // collapsed ToolCallsBlock can show what was being asked for.

  stripped = stripped.replace(PAIRED_TAG_RE, (match) => {
    pushMarker(match);
    return "";
  });

  // Pass 2: remaining single-tag / unclosed forms.
  stripped = stripped.replace(SINGLE_TAG_RE, (match) => {
    pushMarker(match);
    return "";
  });

  // Collapse the whitespace introduced by removed markers. After tool-call
  // markers are stripped, their surrounding \n\n paragraph breaks orphan
  // into micro-segments in useSegmentSplitter (splits on \n\n). Collapse
  // to single \n so the remaining prose merges into coherent segments.
  const finalText = stripped.replace(/\n{2,}/g, "\n").trim();

  // 2026-05-01 fix: previously fell back to returning the original text
  // when stripping emptied everything, mirroring extractThinkTags. That
  // mirror was wrong for tool-call markers — the extracted toolCalls
  // already render in a collapsed ToolCallsBlock; defaulting finalText
  // back to the raw markers re-leaks the same XML the strip aimed to
  // remove. When the entire response WAS markers, return "" so
  // appendAgent's `text: finalText || "(empty response)"` shield kicks
  // in and the bubble shows a clean placeholder.
  return { toolCalls, finalText };
}

/** Count pseudo-tool-call markers without building the full array. */
export function countPseudoToolCallMarkers(text: string): number {
  if (!text || !text.includes("<")) return 0;
  let count = 0;
  const countPaired = text.replace(PAIRED_TAG_RE, () => {
    count++;
    return "";
  });
  countPaired.replace(SINGLE_TAG_RE, () => {
    count++;
    return "";
  });
  return count;
}
