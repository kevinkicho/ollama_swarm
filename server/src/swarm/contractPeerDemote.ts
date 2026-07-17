/**
 * Independent contract-explore coordinator (d3f56d9a follow-up).
 * When the first agent lands a valid draft, abort remaining explorers and
 * let them finish as emit-only from the peer brief (no second full tour).
 */

export const PEER_DRAFT_DEMOTE_REASON = "peer-draft-demote";

export function isPeerDraftDemoteError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes(PEER_DRAFT_DEMOTE_REASON)
    || (typeof (err as { name?: string }).name === "string"
      && /abort/i.test((err as { name: string }).name)
      && /peer.?draft/i.test(msg))
  );
}

export interface PeerDraftCoordinator {
  getPeerBrief: () => string | null;
  getWinnerId: () => string | null;
  registerAbort: (agentId: string, ctrl: AbortController) => void;
  unregisterAbort: (agentId: string) => void;
  noteValidDraft: (agentId: string, draftText: string) => void;
}

export function createPeerDraftCoordinator(
  appendSystem: (msg: string) => void,
): PeerDraftCoordinator {
  let peerBrief: string | null = null;
  let winnerId: string | null = null;
  const aborts = new Map<string, AbortController>();

  return {
    getPeerBrief: () => peerBrief,
    getWinnerId: () => winnerId,
    registerAbort: (agentId, ctrl) => {
      aborts.set(agentId, ctrl);
    },
    unregisterAbort: (agentId) => {
      aborts.delete(agentId);
    },
    noteValidDraft: (agentId, draftText) => {
      if (peerBrief) return;
      const text = draftText.trim();
      if (text.length < 40) return;
      peerBrief = text;
      winnerId = agentId;
      appendSystem(
        `[contract] Peer draft from ${agentId} ready — demoting remaining explorers to emit-only.`,
      );
      for (const [id, ctrl] of aborts) {
        if (id === agentId) continue;
        if (ctrl.signal.aborted) continue;
        try {
          ctrl.abort(new Error(PEER_DRAFT_DEMOTE_REASON));
        } catch {
          /* ignore */
        }
      }
    },
  };
}
