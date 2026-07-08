#!/usr/bin/env node
/**
 * Scan run debug logs for intra-turn text repetition in agent_streaming events.
 * Groups by agent + turn (thinking → streaming_end), then tallies repeat patterns.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const runId = process.argv[2];
if (!runId) {
  console.error("Usage: node scripts/analyze-stream-repeats.mjs <runId-prefix-or-full>");
  process.exit(1);
}

const logsRoot = path.resolve("logs");
const dir = fs.readdirSync(logsRoot).find((d) => d.startsWith(runId));
if (!dir) {
  console.error(`No logs dir matching ${runId}`);
  process.exit(1);
}
const logDir = path.join(logsRoot, dir);

/** @type {Map<string, { text: string, ts: number, chunks: number }>} */
const active = new Map();

/** @type {Array<{ agent: string, agentIndex: number, turn: number, ts: number, textLen: number, repeats: RepeatHit[] }>} */
const turnResults = [];

/** @type {Map<string, number>} */
const turnCounter = new Map();

/** @type {Map<string, { turns: number, withRepeats: number, totalRepeatInstances: number, patterns: Map<string, number> }>} */
const byAgent = new Map();

/** @type {Array<{ ts: number, agent: string, reason: string }>} */
const loggedLoopAborts = [];

function agentKey(agentId, agentIndex) {
  return agentId || `agent-${agentIndex ?? "?"}`;
}

function bumpAgent(agent) {
  if (!byAgent.has(agent)) {
    byAgent.set(agent, { turns: 0, withRepeats: 0, totalRepeatInstances: 0, patterns: new Map() });
  }
  return byAgent.get(agent);
}

/**
 * @typedef {{ kind: string, pattern: string, count: number, suffixLen?: number }} RepeatHit
 * @returns {RepeatHit[]}
 */
function detectRepeats(text) {
  const hits = [];
  if (!text || text.length < 80) return hits;

  // 1) Trailing suffix repeat (production detector uses max 200; we scan up to 500)
  const maxRepeatLen = Math.min(500, Math.floor(text.length / 3));
  for (let rLen = 20; rLen <= maxRepeatLen; rLen++) {
    const tail = text.slice(-rLen);
    let count = 0;
    let pos = text.length;
    while (pos >= rLen && text.slice(pos - rLen, pos) === tail) {
      count++;
      pos -= rLen;
    }
    if (count >= 3) {
      hits.push({
        kind: "trailing_suffix",
        pattern: tail.slice(0, 80).replace(/\s+/g, " "),
        count,
        suffixLen: rLen,
      });
      break; // longest match at this rLen; first hit at this scan is enough
    }
  }

  // 2) High-frequency phrase repeats (>= 8 occurrences)
  const phraseCandidates = [
    /I'll use the IMF Data API: https:\/\/www\.imf\.org\/-\/api\/[^\s]*/g,
    /I'll construct a URL: https:\/\/www\.imf\.org\/-\/api\/[^\s]*/g,
    /https:\/\/www\.imf\.org\/-\/api\/[^\s]*/g,
    /I'll use the following: https:\/\/www\.imf\.org[^\s]*/g,
  ];
  for (const re of phraseCandidates) {
    const m = text.match(re);
    if (m && m.length >= 5) {
      hits.push({
        kind: "phrase",
        pattern: m[0].slice(0, 100),
        count: m.length,
      });
    }
  }

  // 3) Generic repeated sentence-like blocks (20-120 chars, >= 6 times)
  const normalized = text.replace(/\s+/g, " ");
  for (let len = 120; len >= 30; len -= 10) {
    const freq = new Map();
    for (let i = 0; i <= normalized.length - len; i += Math.max(5, Math.floor(len / 4))) {
      const sub = normalized.slice(i, i + len);
      if (sub.trim().length < 25) continue;
      freq.set(sub, (freq.get(sub) || 0) + 1);
    }
    let best = null;
    for (const [sub, c] of freq) {
      if (c >= 6 && (!best || c > best.count)) best = { sub, count: c };
    }
    if (best) {
      // verify true consecutive or near-consecutive global count
      const escaped = best.sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const global = (normalized.match(new RegExp(escaped, "g")) || []).length;
      if (global >= 6) {
        hits.push({
          kind: "block",
          pattern: best.sub.slice(0, 100),
          count: global,
        });
        break;
      }
    }
  }

  return hits;
}

function finalizeTurn(agentId, agentIndex, ts) {
  const key = agentKey(agentId, agentIndex);
  const cur = active.get(key);
  if (!cur || !cur.text) return;
  const turn = (turnCounter.get(key) || 0) + 1;
  turnCounter.set(key, turn);
  const repeats = detectRepeats(cur.text);
  const ag = bumpAgent(key);
  ag.turns++;
  if (repeats.length > 0) {
    ag.withRepeats++;
    for (const r of repeats) {
      ag.totalRepeatInstances += Math.max(0, r.count - 1);
      const pk = `${r.kind}:${r.pattern.slice(0, 60)}`;
      ag.patterns.set(pk, (ag.patterns.get(pk) || 0) + 1);
    }
  }
  turnResults.push({
    agent: key,
    agentIndex: agentIndex ?? (Number.parseInt(key.replace("agent-", ""), 10) || 0),
    turn,
    ts: cur.ts || ts,
    textLen: cur.text.length,
    repeats,
  });
  active.delete(key);
}

function processLine(line) {
  if (!line.trim()) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const ev = o.event;
  if (!ev) return;

  if (ev.type === "agent_streaming") {
    const key = agentKey(ev.agentId, ev.agentIndex);
    const prev = active.get(key) || { text: "", ts: o.ts, chunks: 0 };
    // Streaming events carry cumulative text
    if (typeof ev.text === "string" && ev.text.length >= prev.text.length) {
      prev.text = ev.text;
    }
    prev.chunks++;
    prev.ts = o.ts;
    active.set(key, prev);
    return;
  }

  if (ev.type === "agent_streaming_end") {
    finalizeTurn(ev.agentId, ev.agentIndex, o.ts);
    return;
  }

  if (ev.type === "agent_state" && ev.agent?.status === "thinking") {
    const key = agentKey(ev.agent.id, ev.agent.index);
    // New thinking session — if we still have buffered stream, finalize first
    if (active.has(key)) finalizeTurn(ev.agent.id, ev.agent.index, o.ts);
    active.set(key, { text: "", ts: o.ts, chunks: 0 });
    return;
  }

  if (/intra-stream loop/i.test(line)) {
    loggedLoopAborts.push({
      ts: o.ts,
      agent: ev.agentId || "?",
      reason: line.slice(0, 250),
    });
  }
}

function processFile(filePath) {
  const raw = filePath.endsWith(".gz")
    ? zlib.gunzipSync(fs.readFileSync(filePath))
    : fs.readFileSync(filePath);
  for (const line of raw.toString("utf8").split("\n")) processLine(line);
}

const files = [];
if (fs.existsSync(path.join(logDir, "debug.jsonl"))) {
  files.push(path.join(logDir, "debug.jsonl"));
}
for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith(".gz")).sort()) {
  files.push(path.join(logDir, f));
}

console.error(`Scanning ${files.length} files in ${logDir}...`);
for (const f of files) processFile(f);

// Finalize any dangling streams
for (const [key, cur] of active) {
  const m = key.match(/^agent-(\d+)$/);
  finalizeTurn(key, m ? Number(m[1]) : undefined, cur.ts);
}

const severeTurns = turnResults
  .filter((t) => t.repeats.some((r) => r.count >= 8))
  .sort((a, b) => b.repeats.reduce((s, r) => s + r.count, 0) - a.repeats.reduce((s, r) => s + r.count, 0));

console.log(JSON.stringify({
  runId: dir,
  filesScanned: files.length,
  summary: {
    totalTurns: turnResults.length,
    turnsWithRepeats: turnResults.filter((t) => t.repeats.length > 0).length,
    severeTurns: severeTurns.length,
    loggedLoopAborts: loggedLoopAborts.length,
    byAgent: Object.fromEntries(
      [...byAgent.entries()].map(([k, v]) => [
        k,
        {
          turns: v.turns,
          turnsWithRepeats: v.withRepeats,
          estimatedExtraRepeatBlocks: v.totalRepeatInstances,
          topPatterns: [...v.patterns.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([p, c]) => ({ pattern: p, turnHits: c })),
        },
      ]),
    ),
  },
  topSevereTurns: severeTurns.slice(0, 25).map((t) => ({
    agent: t.agent,
    turn: t.turn,
    time: new Date(t.ts).toLocaleString(),
    textLen: t.textLen,
    repeats: t.repeats,
  })),
  loggedLoopAborts: loggedLoopAborts.slice(0, 20),
}, null, 2));