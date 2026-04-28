// Extract <think>...</think> reasoning sections from agent text.
//
// Modern reasoning models (deepseek-v3+, glm-5.1 in some modes,
// gpt-o1, claude-extended-thinking) wrap their internal chain-of-
// thought in `<think>...</think>` markers. Every modern chat UI
// (opencode, ChatGPT, Claude.ai, Cursor) detects these markers and
// renders the thoughts collapsed-by-default with a "show thinking"
// expand. Pre-fix our bubbles rendered them as plain text including
// stray closing tags when the bubble started mid-thought.
//
// This helper is the first slice of the UI coherent-fix package
// (docs/plans/ui-coherent-fix-package.md, Phase 1). Pure shape-
// transform: text in → { thoughts, finalText } out. No I/O, no
// dependencies. Caller decides what to do with the thoughts string
// (server-side: stash on TranscriptEntry.thoughts; client-side:
// render in a ThoughtsBlock).

/**
 * Split agent text into thoughts (concatenated <think>...</think>
 * blocks) and the final visible response.
 *
 * Behavior:
 *  - Multiple <think>...</think> blocks are joined with a divider.
 *  - An UNCLOSED <think> at the end is treated as a thought (model
 *    likely crashed mid-thought; better to surface as collapsed
 *    thought than as raw text with a stray opening tag).
 *  - If extraction empties the final text entirely, return the
 *    ORIGINAL text as finalText so the bubble doesn't render empty.
 *  - No <think> tags at all → thoughts="", finalText=input verbatim.
 */
export function extractThinkTags(text: string): {
  thoughts: string;
  finalText: string;
} {
  if (!text) return { thoughts: "", finalText: text };
  // Fast path: no markers at all.
  if (!text.includes("<think>") && !text.includes("</think>")) {
    return { thoughts: "", finalText: text };
  }

  const thoughts: string[] = [];
  let working = text;

  // Edge case (RCA from preset 1, run af27f55c, 2026-04-27 evening):
  // some models stream a response that STARTS mid-thought — there's a
  // </think> closer before any <think> opener. Treat the prefix as a
  // thought and consume the leaked closing tag. Without this, the
  // closer leaked into the visible bubble (e.g. "</think>```json[]```"
  // displayed as raw text in the planner output).
  const firstClose = working.indexOf("</think>");
  const firstOpen = working.indexOf("<think>");
  if (firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen)) {
    const head = working.slice(0, firstClose).trim();
    if (head.length > 0) thoughts.push(head);
    working = working.slice(firstClose + "</think>".length);
  }

  // Paired blocks.
  const thinkRe = /<think>([\s\S]*?)<\/think>/g;
  let stripped = working.replace(thinkRe, (_match, content: string) => {
    const trimmed = content.trim();
    if (trimmed.length > 0) thoughts.push(trimmed);
    return "";
  });

  // Handle an UNCLOSED <think> at the tail (model crashed mid-thought
  // or the response was truncated). Anything after the last opening
  // tag becomes a thought; everything before stays as finalText.
  const unclosedIdx = stripped.lastIndexOf("<think>");
  if (unclosedIdx !== -1) {
    const tail = stripped.slice(unclosedIdx + "<think>".length).trim();
    if (tail.length > 0) thoughts.push(tail);
    stripped = stripped.slice(0, unclosedIdx);
  }

  // Collapse the whitespace introduced by removed <think> blocks.
  // Two newlines max in a row keeps paragraph structure intact.
  const finalText = stripped.replace(/\n{3,}/g, "\n\n").trim();

  return {
    thoughts: thoughts.join("\n\n---\n\n"),
    // If extraction emptied everything, fall back to the original
    // text — the bubble must render SOMETHING. The thoughts block
    // still surfaces the same content (with the tags stripped
    // visible), so the user isn't worse off than pre-fix.
    finalText: finalText.length > 0 ? finalText : text,
  };
}
