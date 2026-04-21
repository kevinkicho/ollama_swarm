import { Router, type Request, type Response } from "express";
import type { Broadcaster } from "../ws/broadcast.js";
import { Board } from "../swarm/blackboard/Board.js";
import { createBoardBroadcaster } from "../swarm/blackboard/boardBroadcaster.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Temporary Phase 2 route: builds a throwaway Board and walks it through every
// BoardEvent type so a browser connected to /ws can verify the pipeline end-to-
// end. Delete once the real blackboard runner is wired up in a later phase.
export function devRouter(broadcaster: Broadcaster): Router {
  const r = Router();

  r.post("/board-poke", async (_req: Request, res: Response) => {
    const bb = createBoardBroadcaster((ev) => broadcaster.broadcast(ev));
    const board = new Board({ emit: bb.emit });
    bb.bindBoard(board);

    try {
      // 1. post + claim + commit (happy path)
      const a = board.postTodo({
        description: "rename export in src/a.ts",
        expectedFiles: ["src/a.ts"],
        createdBy: "planner-dev",
        createdAt: Date.now(),
      });
      await sleep(200);
      board.claimTodo({
        todoId: a.id,
        agentId: "agent-1",
        fileHashes: { "src/a.ts": "hashA1" },
        claimedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      await sleep(200);
      board.commitTodo({
        todoId: a.id,
        agentId: "agent-1",
        currentHashes: { "src/a.ts": "hashA1" },
        committedAt: Date.now(),
      });
      await sleep(200);

      // 2. post + claim + markStale + replan + skip (rescue path)
      const b = board.postTodo({
        description: "update import in src/b.ts",
        expectedFiles: ["src/b.ts"],
        createdBy: "planner-dev",
        createdAt: Date.now(),
      });
      await sleep(200);
      board.claimTodo({
        todoId: b.id,
        agentId: "agent-2",
        fileHashes: { "src/b.ts": "hashB1" },
        claimedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      await sleep(200);
      board.markStale(b.id, "simulated hash mismatch");
      await sleep(200);
      board.replan(b.id, {
        description: "update import in src/b.ts (retry)",
        expectedFiles: ["src/b.ts", "src/b.test.ts"],
      });
      await sleep(200);
      board.skip(b.id, "demo skip — not actually failing");
      await sleep(200);

      // 3. finding
      board.postFinding({
        agentId: "agent-1",
        text: "observed that /ws pipes board events correctly",
        createdAt: Date.now(),
      });
      await sleep(200);

      // Make sure a final snapshot lands even if the debounce timer hasn't fired.
      bb.flushSnapshot();
      res.json({ ok: true, counts: board.counts() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    } finally {
      bb.dispose();
    }
  });

  return r;
}
