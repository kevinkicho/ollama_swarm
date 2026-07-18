#!/usr/bin/env node
/**
 * Tiny example "Brain-OS agent" loop.
 *
 * Demonstrates an external agent using the Brain chat + CLI + APIs
 * to go from a high-level goal to a running swarm (with recommendation + analysis).
 *
 * Run with: node examples/brain-agent-loop.mjs "your goal here"
 *
 * It uses:
 * - POST /api/swarm/brain/chat for natural language recommendation
 * - The recommender + stats (now proactively quoted by Brain)
 * - CLI (or direct API) to start
 *
 * This is intentionally simple to show the loop.
 */

const SERVER = process.env.OLLAMA_SWARM_SERVER_URL || 'http://localhost:8243';
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const goal = args.join(' ') || 'analyze recent papers on room-temperature superconductors and synthesize the common crystal and electronic features';
// Optional fixed start params for --use-prior demos (blackboard continuous)
const PRIOR_PARAMS = { preset: 'blackboard', agentCount: 5, rounds: 0 };
if (process.argv.includes('--use-prior')) {
  console.log('[brain-agent] Using prior run data for start params:', PRIOR_PARAMS);
}
const DO_REAL_START = process.argv.includes('--real-start'); // safety flag

console.log(`[brain-agent] Goal: ${goal}\n`);
if (DO_REAL_START) console.log('[brain-agent] WARNING: --real-start will actually start a swarm!\n');
if (process.argv.includes('--simulate')) {
  console.error('[brain-agent] --simulate mock mode was removed; start the server and run without --simulate.');
  process.exit(1);
}

async function askBrain(extraBody = {}) {
  const res = await fetch(`${SERVER}/api/swarm/brain/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: goal }],
      ...extraBody
    })
  });
  const data = await res.json();
  return data.reply || '';
}

async function getStatus(runId = null) {
  let url = `${SERVER}/api/swarm/status`;
  if (runId) url += `?runId=${encodeURIComponent(runId)}`;
  const res = await fetch(url);
  return res.json();
}

async function postAmend(runId, text) {
  const res = await fetch(`${SERVER}/api/swarm/amend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, text })
  });
  return res.json();
}

async function doStart(config, dry = true) {
  if (dry) {
    return { dryRun: true, config };
  }
  const res = await fetch(`${SERVER}/api/swarm/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  return res.json();
}

async function main() {
  console.log('[brain-agent] Asking Brain for recommendation + analysis...');
  const reply = await askBrain();
  console.log('\n--- Brain reply ---\n' + reply + '\n');

  // Better JSON extraction (fenced blocks + first balanced object, similar to shared extractJson)
  function extractJson(text) {
    const trimmed = text.trim();
    // fenced json
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let candidate = fence ? fence[1] : trimmed;
    // find first balanced { ... }
    let depth = 0, start = -1, end = -1;
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (candidate[i] === '}') {
        depth--;
        if (depth === 0 && start !== -1) { end = i + 1; break; }
      }
    }
    if (start !== -1 && end !== -1) {
      try { return JSON.parse(candidate.slice(start, end)); } catch {}
    }
    // fallback any object
    const any = candidate.match(/\{[\s\S]*\}/);
    if (any) { try { return JSON.parse(any[0]); } catch {} }
    return null;
  }
  const parsed = extractJson(reply);
  let config = parsed;
  if (parsed && !parsed.preset && parsed.config) config = parsed.config; // if wrapped
  if (!config && parsed) config = parsed;

  if (!config || !config.preset) {
    console.log('[brain-agent] Could not extract config.');
    return;
  }

  console.log(`[brain-agent] Recommended preset: ${config.preset}`);

  // Start (dry by default)
  console.log('[brain-agent] Preparing start...');
  const startResult = await doStart(config, !DO_REAL_START);
  console.log(startResult);

  let runId = null;
  if (DO_REAL_START && startResult.runId) {
    runId = startResult.runId;
    console.log(`[brain-agent] Real run started: ${runId}`);

    // Poll status a few times
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const status = await getStatus(runId);
      console.log(`[brain-agent] Poll ${i+1}: phase=${status.phase || status.status?.phase}, runId=${runId}`);
    }

    // Example amend
    console.log('[brain-agent] Sending example amend...');
    const amendRes = await postAmend(runId, 'Focus more on the key findings from the research.');
    console.log(amendRes);
  } else {
    console.log('[brain-agent] (dry-run or no runId) - skipping polling/amend demo.');
    console.log('[brain-agent] To do a full demo: node examples/brain-agent-loop.mjs --real-start "your goal" (after server is up)');
  }

  // Bonus: ask Brain for live context simulation (would pass runContext in real)
  if (runId) {
    console.log('[brain-agent] Asking Brain with simulated runContext...');
    const liveReply = await askBrain({ runContext: { runId, phase: 'executing', recentTranscript: ['progress update...'] } });
    console.log('Live reply snippet:', liveReply.slice(0, 200) + '...');
  }
}

main().catch(console.error);
