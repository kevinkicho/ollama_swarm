#!/usr/bin/env node
/** Fast per-turn repetition tally for a run's debug logs. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";

const runPrefix = process.argv[2] || "529adccb";
const logsRoot = path.resolve("logs");
const dirName = fs.readdirSync(logsRoot).find((d) => d.startsWith(runPrefix));
if (!dirName) {
  console.error("run not found");
  process.exit(1);
}
const logDir = path.join(logsRoot, dirName);

const PHRASES = [
  { name: "imf_data_api", re: /I'll use the IMF Data API/g },
  { name: "imf_construct_url", re: /I'll construct a URL: https:\/\/www\.imf\.org/g },
  { name: "imf_api_url", re: /https:\/\/www\.imf\.org\/-\/api\//g },
  { name: "imf_use_following", re: /I'll use the following: https:\/\/www\.imf\.org/g },
];

/** @type {Map<string, { text: string, ts: number }>} */
const buf = new Map();
/** @type {Map<string, number>} */
const turnNo = new Map();

const perAgent = new Map();
const severeTurns = [];
const loopAborts = [];

function agentOf(ev) {
  return ev.agentId || (ev.agent?.index != null ? `agent-${ev.agent.index}` : "?");
}

function ensureAgent(a) {
  if (!perAgent.has(a)) {
    perAgent.set(a, {
      turns: 0,
      repeatTurns: 0,
      phrases: Object.fromEntries(PHRASES.map((p) => [p.name, 0])),
      maxPhraseInTurn: Object.fromEntries(PHRASES.map((p) => [p.name, 0])),
      intraLoopAborts: 0,
    });
  }
  return perAgent.get(a);
}

function trailingSuffixRepeats(text) {
  if (text.length < 60) return null;
  const maxLen = Math.min(500, Math.floor(text.length / 3));
  for (let rLen = maxLen; rLen >= 20; rLen--) {
    const tail = text.slice(-rLen);
    let count = 0;
    let pos = text.length;
    while (pos >= rLen && text.slice(pos - rLen, pos) === tail) {
      count++;
      pos -= rLen;
    }
    if (count >= 3) {
      return { suffixLen: rLen, count, sample: tail.slice(0, 90).replace(/\s+/g, " ") };
    }
  }
  return null;
}

function finalize(agent, ts) {
  const cur = buf.get(agent);
  buf.delete(agent);
  if (!cur?.text) return;
  const turn = (turnNo.get(agent) || 0) + 1;
  turnNo.set(agent, turn);
  const ag = ensureAgent(agent);
  ag.turns++;

  const phraseHits = {};
  let repeatTurn = false;
  for (const p of PHRASES) {
    const c = (cur.text.match(p.re) || []).length;
    phraseHits[p.name] = c;
    if (c > 0) ag.phrases[p.name] += c;
    if (c > ag.maxPhraseInTurn[p.name]) ag.maxPhraseInTurn[p.name] = c;
    if (c >= 5) repeatTurn = true;
  }

  const suffix = trailingSuffixRepeats(cur.text);
  if (suffix && suffix.count >= 3) repeatTurn = true;

  if (repeatTurn) {
    ag.repeatTurns++;
    severeTurns.push({
      agent,
      turn,
      time: new Date(ts).toLocaleString(),
      textLen: cur.text.length,
      phrases: phraseHits,
      suffix,
    });
  }
}

async function processLines(iter) {
  for await (const line of iter) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = o.event;
    if (!ev) continue;

    if (/intra-stream loop/i.test(line)) {
      const agent = agentOf(ev);
      ensureAgent(agent).intraLoopAborts++;
      loopAborts.push({ ts: o.ts, agent, line: line.slice(0, 220) });
    }

    if (ev.type === "agent_streaming") {
      const agent = agentOf(ev);
      if (typeof ev.text === "string") {
        const prev = buf.get(agent);
        if (!prev || ev.text.length >= (prev.text?.length || 0)) {
          buf.set(agent, { text: ev.text, ts: o.ts });
        }
      }
      continue;
    }

    if (ev.type === "agent_streaming_end") {
      finalize(agentOf(ev), o.ts);
      continue;
    }

    if (ev.type === "agent_state" && ev.agent?.status === "thinking") {
      const agent = agentOf(ev);
      if (buf.has(agent)) finalize(agent, o.ts);
    }
  }
}

async function processFile(fp) {
  const stream = fp.endsWith(".gz")
    ? zlib.createGunzip()
    : null;
  const input = fs.createReadStream(fp);
  if (stream) input.pipe(stream);
  const rl = readline.createInterface({ input: stream || input, crlfDelay: Infinity });
  await processLines(rl);
}

const files = [];
if (fs.existsSync(path.join(logDir, "debug.jsonl"))) files.push(path.join(logDir, "debug.jsonl"));
for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith(".gz")).sort()) {
  files.push(path.join(logDir, f));
}

console.error(`Scanning ${files.length} files...`);
for (const f of files) await processFile(f);
for (const [agent, cur] of buf) finalize(agent, cur.ts);

severeTurns.sort((a, b) => {
  const score = (t) => Math.max(...Object.values(t.phrases), t.suffix?.count || 0);
  return score(b) - score(a);
});

const out = {
  runId: dirName,
  filesScanned: files.length,
  perAgent: Object.fromEntries([...perAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  totals: {
    turns: [...perAgent.values()].reduce((s, a) => s + a.turns, 0),
    repeatTurns: [...perAgent.values()].reduce((s, a) => s + a.repeatTurns, 0),
    loopAborts: loopAborts.length,
  },
  topSevereTurns: severeTurns.slice(0, 40),
  loopAborts: loopAborts.slice(0, 30),
};
process.stdout.write(JSON.stringify(out, null, 2));