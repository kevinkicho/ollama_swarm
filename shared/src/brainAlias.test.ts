import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isBrainAgentName,
  resolveBrainAgentId,
  textMentionsBrainAlias,
} from "./brainAlias.js";

describe("brainAlias", () => {
  it("isBrainAgentName recognizes brain and brian", () => {
    assert.equal(isBrainAgentName("brain"), true);
    assert.equal(isBrainAgentName("Brain"), true);
    assert.equal(isBrainAgentName("brian"), true);
    assert.equal(isBrainAgentName("Brian"), true);
    assert.equal(isBrainAgentName("agent-2"), false);
  });

  it("resolveBrainAgentId maps aliases to brain", () => {
    assert.equal(resolveBrainAgentId("brian"), "brain");
    assert.equal(resolveBrainAgentId("Brian"), "brain");
    assert.equal(resolveBrainAgentId("brain"), "brain");
    assert.equal(resolveBrainAgentId("agent-2"), "agent-2");
  });

  it("textMentionsBrainAlias detects word-boundary mentions", () => {
    assert.equal(textMentionsBrainAlias("hey Brian, what is happening?"), true);
    assert.equal(textMentionsBrainAlias("ask brain for help"), true);
    assert.equal(textMentionsBrainAlias("no mention here"), false);
  });
});