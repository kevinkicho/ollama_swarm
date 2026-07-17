import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PEER_DRAFT_DEMOTE_REASON,
  createPeerDraftCoordinator,
  isPeerDraftDemoteError,
} from "./contractPeerDemote.js";

describe("contractPeerDemote", () => {
  it("first valid draft aborts other explorers", () => {
    const logs: string[] = [];
    const peer = createPeerDraftCoordinator((m) => logs.push(m));
    const a = new AbortController();
    const b = new AbortController();
    peer.registerAbort("agent-1", a);
    peer.registerAbort("agent-2", b);
    peer.noteValidDraft(
      "agent-1",
      '{"missionStatement":"Add gov panels across market tabs","criteria":[{"description":"FX panel","expectedFiles":["a.js"]}]}',
    );
    assert.ok(peer.getPeerBrief());
    assert.equal(peer.getWinnerId(), "agent-1");
    assert.equal(a.signal.aborted, false);
    assert.equal(b.signal.aborted, true);
    assert.ok(logs.some((l) => /demoting remaining explorers/i.test(l)));
    assert.equal(isPeerDraftDemoteError(b.signal.reason), true);
    assert.match(String(b.signal.reason), new RegExp(PEER_DRAFT_DEMOTE_REASON));
  });

  it("second noteValidDraft is a no-op", () => {
    const peer = createPeerDraftCoordinator(() => {});
    peer.noteValidDraft("agent-1", '{"missionStatement":"first","criteria":[]}');
    peer.noteValidDraft("agent-2", '{"missionStatement":"second","criteria":[]}');
    assert.match(peer.getPeerBrief()!, /first/);
    assert.equal(peer.getWinnerId(), "agent-1");
  });
});
