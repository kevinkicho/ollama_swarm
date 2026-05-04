// T-Item-2 (2026-05-04): per-stream state container for parallel
// debate streams.
//
// Each stream owns: a unique id ("stream-1", ...), the proposition
// being debated, references to the PRO + CON agents (REUSED across
// all streams in a multi-stream run — agents have no per-stream
// memory because each prompt is fully self-contained), a scoped
// transcript view, and the stream's verdict (set when the per-stream
// JUDGE turn parses).
//
// The runner's main transcript remains the single source of truth
// for replay/persistence — every entry pushed to a stream also
// lands on the main transcript with the streamId tag. The local
// `transcript` view is what per-stream prompt builders read from
// so each stream's PRO/CON only see THEIR OWN debate, not other
// streams' parallel arguments.

import type { Agent } from "../services/AgentManager.js";
import type { TranscriptEntry } from "../types.js";
import type { ParsedDebateVerdict } from "./DebateJudgeRunner.js";

export interface DebateStreamInit {
  id: string;
  proposition: string;
  pro: Agent;
  con: Agent;
}

export class DebateStream {
  readonly id: string;
  readonly proposition: string;
  readonly pro: Agent;
  readonly con: Agent;
  /** Local view of entries belonging to this stream. The same entries
   *  also live on the runner's main transcript (with streamId tag). */
  transcript: TranscriptEntry[] = [];
  /** Set when the per-stream JUDGE turn parses a verdict. Null until then. */
  verdict: ParsedDebateVerdict | null = null;

  constructor(init: DebateStreamInit) {
    this.id = init.id;
    this.proposition = init.proposition;
    this.pro = init.pro;
    this.con = init.con;
  }

  /** Tag-and-fork: push to BOTH the runner's main transcript and this
   *  stream's local view, with `streamId` set on the entry. The main
   *  push is via the supplied callback (so the runner can also emit
   *  the WS broadcast in the same step). */
  appendEntry(
    entry: TranscriptEntry,
    pushToMain: (e: TranscriptEntry) => void,
  ): void {
    const tagged: TranscriptEntry = { ...entry, streamId: this.id };
    pushToMain(tagged);
    this.transcript.push(tagged);
  }
}
