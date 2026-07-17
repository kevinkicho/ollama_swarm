import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "discussionRunAgent.ts"), "utf8");

describe("discussionRunAgent — draft salvage wiring", () => {
  it("posts salvage draft on error when enrichSummary/draft mode", () => {
    assert.match(SRC, /buildFailedDraftBody/);
    assert.match(SRC, /salvage draft posted/);
    assert.match(SRC, /pushDiscussionEntry/);
  });

  it("uses soft draft nudge without low hard tool cap", () => {
    assert.doesNotMatch(SRC, /maxToolTurns:\s*EXPLORE_MAX_DISCUSSION_DRAFT_TOOL_TURNS/);
    assert.match(SRC, /discussionDraftJsonNudge/);
    assert.match(SRC, /createThinkGuardHandler/);
  });

  it("does not return empty string silently when draft enrichSummary is set", () => {
    // Catch path must call pushDiscussionEntry before any bare return ""
    const catchBlock =
      SRC.match(/catch \(err\) \{[\s\S]*?finally \{/)?.[0] ?? "";
    assert.match(catchBlock, /pushDiscussionEntry/);
    assert.match(catchBlock, /opts\.enrichSummary \|\| draftMode/);
  });
});
