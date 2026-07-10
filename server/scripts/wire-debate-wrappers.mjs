import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const path = join(__dirname, "../src/swarm/DebateJudgeRunner.ts");
let src = readFileSync(path, "utf8");

const mStart = src.indexOf("  private async runSingleStreamDebate(");
const mEnd = src.indexOf("  private async runAgent(");
if (mStart < 0 || mEnd < 0) throw new Error(`markers ${mStart} ${mEnd}`);

const replacement = `  private debateHost(): DebateStreamsHost {
    return {
      manager: this.opts.manager,
      transcript: this.transcript,
      proposition: this.proposition,
      logDiag: this.opts.logDiag,
      getStopping: () => this.stopping,
      setEarlyStopDetail: (d) => { this.earlyStopDetail = d; },
      appendSystem: (t, s) => this.appendSystem(t, s as any),
      checkRoundBudget: (c, u, r, b) => this.checkRoundBudget(c, u, r, b),
      runAgent: (a, p, tag, enr, name, stream) => this.runAgent(a, p, tag, enr, name, stream),
    };
  }

  // Stream/cycle helpers extracted to debateStreams.ts; thin wrappers preserve call sites.
  private async runSingleStreamDebate(
    agents: { pro: Agent; con: Agent; judge: Agent },
    proposition: string,
    cfg: RunConfig,
    stream?: DebateStream,
  ): Promise<ParsedDebateVerdict | null> {
    return runSingleStreamDebateExtracted(this.debateHost(), agents, proposition, cfg, stream);
  }

  private async runMultiStreamDebate(
    agents: { pro: Agent; con: Agent; judge: Agent },
    K: number,
    cfg: RunConfig,
  ): Promise<ParsedDebateVerdict | null> {
    return runMultiStreamDebateExtracted(this.debateHost(), agents, K, cfg);
  }

  private async runCrossStreamJudge(
    judge: Agent,
    streams: readonly DebateStream[],
    cfg: RunConfig,
  ): Promise<string | null> {
    return runCrossStreamJudgeExtracted(this.debateHost(), judge, streams, cfg);
  }

  private async runDebaterTurn(
    agent: Agent,
    side: "pro" | "con",
    round: number,
    totalRounds: number,
    proposition: string,
    isFinalRound: boolean,
    userDirective?: string,
    stream?: DebateStream,
  ): Promise<void> {
    return runDebaterTurnExtracted(
      this.debateHost(),
      agent,
      side,
      round,
      totalRounds,
      proposition,
      isFinalRound,
      userDirective,
      stream,
    );
  }

  private async runNextActionPhase(
    pro: Agent,
    con: Agent,
    judge: Agent,
    proposition: string,
    verdict: ParsedDebateVerdict,
    userDirective?: string,
  ): Promise<void> {
    return runNextActionPhaseExtracted(
      this.debateHost(),
      pro,
      con,
      judge,
      proposition,
      verdict,
      userDirective,
    );
  }

  private async rankParallelPropositions(
    judge: import("../services/AgentManager.js").Agent,
    directive: string,
    propositions: readonly string[],
  ): Promise<number | null> {
    return rankParallelPropositions(judge, this.opts.manager, directive, propositions);
  }

  private async runJudgeTurn(
    judge: Agent,
    proposition: string,
    round: number,
    userDirective?: string,
    stream?: DebateStream,
  ): Promise<ParsedDebateVerdict | null> {
    return runJudgeTurnExtracted(
      this.debateHost(),
      judge,
      proposition,
      round,
      userDirective,
      stream,
    );
  }

`;

src = src.slice(0, mStart) + replacement + src.slice(mEnd);
writeFileSync(path, src);
console.log("wired DebateJudgeRunner, lines", src.split("\n").length);
