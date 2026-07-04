#!/usr/bin/env node
/**
 * ollama-swarm CLI
 *
 * Control interface for humans and **Brain-OS agents**.
 * Supports the full loop: recommend preset, start, monitor (status), steer (amend), stop.
 *
 * Requires the ollama-swarm server running.
 *
 * Examples for agents / Brain-OS:
 *   ollama-swarm recommend --directive "analyze papers on superconductors and synthesize common properties"
 *   ollama-swarm start --config swarm_config.json
 *   ollama-swarm status --runId abc123
 *   ollama-swarm amend --runId abc123 --text "focus more on crystal structure"
 *   ollama-swarm stop --runId abc123
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';

const DEFAULT_SERVER = process.env.OLLAMA_SWARM_SERVER_URL || 'http://localhost:8243';

function printHelp() {
  console.log(`
ollama-swarm — control ollama_swarm from terminal or Brain-OS agents

Commands (full control loop for agents):
  start        Start a swarm (flags or --config from Brain)
  status       Show status (global or --run-id)
  amend        Send amendment to a running swarm (--run-id + --text)
  stop         Stop a run (--run-id)
  recommend    Get Brain-style preset recommendation for a directive

Examples for Brain-OS agents:
  ollama-swarm recommend --directive "scan papers and synthesize common properties"
  ollama-swarm start --directive "..." --preset council --web-tools
  ollama-swarm status --run-id abc123
  ollama-swarm amend --run-id abc123 --text "focus on the board todos for X"
  ollama-swarm stop --run-id abc123

Common options:
  --config <file>          JSON config (from Brain chat)
  --directive, -d <text>
  --preset <name>
  --agent-count <n>  --rounds <n>  --model <str>
  --parent-path, --repo-url, --server, --clone-path, --run-id, --text, --dry-run, --help
`);
}

async function startRun(config, serverUrl) {
  const url = `${serverUrl.replace(/\/$/, '')}/api/swarm/start`;

  console.log(`[ollama-swarm] Starting run via ${url} ...`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = body?.error || body?.message || `HTTP ${res.status}`;
      console.error('[ollama-swarm] Start failed:', msg);
      process.exitCode = 1;
      return;
    }

    const runId = body.runId || body?.status?.runId || body.navigateTo?.split('/').pop();
    const navigateTo = body.navigateTo || (runId ? `/runs/${runId}` : null);

    console.log('\n✅ Swarm run started successfully!');
    if (runId) console.log(`   runId: ${runId}`);
    if (navigateTo) {
      const webBase = serverUrl.replace(':8243', ':8244').replace(/\/$/, '');
      console.log(`   UI:      ${webBase}${navigateTo}`);
    }
    console.log('\nMonitor progress in the web UI or with your logs.');
  } catch (err) {
    console.error('[ollama-swarm] Failed to contact server:', err.message);
    console.error('Is the server running? Try: npm run dev');
    process.exitCode = 1;
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error || body?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

async function cmdStatus(values, serverUrl) {
  const runId = values['run-id'] || values.runId;
  let url = `${serverUrl.replace(/\/$/, '')}/api/swarm/status`;
  if (runId) url += `?runId=${encodeURIComponent(runId)}`;
  const data = await fetchJson(url);
  if (values.json) {
    console.log(JSON.stringify(data));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function cmdAmend(values, serverUrl) {
  const runId = values['run-id'] || values.runId;
  const text = values.text || values.directive;
  if (!runId || !text) {
    console.error('amend requires --run-id and --text (or --directive)');
    process.exit(1);
  }
  const url = `${serverUrl.replace(/\/$/, '')}/api/swarm/amend`;
  const body = { runId, text };
  const res = await fetchJson(url, { method: 'POST', body: JSON.stringify(body) });
  console.log('✅ Amend sent:', res);
}

async function cmdStop(values, serverUrl) {
  const runId = values['run-id'] || values.runId;
  if (!runId) {
    console.error('stop requires --run-id');
    process.exit(1);
  }
  const url = `${serverUrl.replace(/\/$/, '')}/api/swarm/runs/${encodeURIComponent(runId)}/stop`;
  await fetchJson(url, { method: 'POST' });
  console.log(`✅ Stop requested for ${runId}`);
}

async function cmdRecommend(values, serverUrl) {
  const directive = values.directive || values.d;
  if (!directive) {
    console.error('recommend requires --directive "your goal..."');
    process.exit(1);
  }
  let url = `${serverUrl.replace(/\/$/, '')}/api/swarm/outcome/recommend?directive=${encodeURIComponent(directive)}`;
  if (values['clone-path']) url += `&clonePath=${encodeURIComponent(values['clone-path'])}`;
  const data = await fetchJson(url);
  if (values.json) {
    console.log(JSON.stringify(data));
  } else {
    console.log('Recommended preset:');
    console.dir(data, { depth: 2 });
    console.log('\nUse with: ollama-swarm start --preset ' + data.preset + ' --directive "..."');
  }
}

async function cmdStart(values, serverUrl) {
  let config = {};

  if (values.config) {
    try {
      const raw = readFileSync(values.config, 'utf8');
      config = JSON.parse(raw);
      console.log(`[ollama-swarm] Loaded config from ${values.config}`);
    } catch (e) {
      console.error('[ollama-swarm] Failed to read --config file:', e.message);
      process.exit(1);
    }
  }

  if (values['parent-path']) config.parentPath = values['parent-path'];
  if (values['repo-url'] !== undefined) config.repoUrl = values['repo-url'];
  if (values.directive) config.userDirective = values.directive;
  if (values.preset) config.preset = values.preset;
  const ac = values['agent-count'] || values.agents;
  if (ac) config.agentCount = Number(ac);
  if (values.rounds != null) config.rounds = Number(values.rounds);
  if (values.model) config.model = values.model;

  if (!config.preset) config.preset = 'blackboard';
  if (!config.agentCount) config.agentCount = 5;
  if (config.rounds == null) config.rounds = 0;
  if (!config.model) config.model = 'deepseek-v4-flash:cloud';
  if (config.repoUrl === undefined) config.repoUrl = '';

  if (values['dry-run']) {
    const out = { dryRun: true, config, server: serverUrl };
    if (values.json) {
      console.log(JSON.stringify(out));
    } else {
      console.log('\n[DRY RUN] Would POST this to /api/swarm/start:');
      console.dir(config, { depth: null });
      console.log(`\nServer: ${serverUrl}`);
    }
    return;
  }

  await startRun(config, serverUrl);
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: 'string' },
      'parent-path': { type: 'string' },
      'repo-url': { type: 'string' },
      directive: { type: 'string', short: 'd' },
      preset: { type: 'string' },
      'agent-count': { type: 'string' },
      agents: { type: 'string' },
      rounds: { type: 'string' },
      model: { type: 'string' },
      server: { type: 'string' },
      'run-id': { type: 'string' },
      'clone-path': { type: 'string' },
      text: { type: 'string' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  const cmd = positionals[0] || 'help';
  const serverUrl = values.server || DEFAULT_SERVER;

  if (values.help || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  try {
    switch (cmd) {
      case 'start':
        await cmdStart(values, serverUrl);
        break;
      case 'status':
        await cmdStatus(values, serverUrl);
        break;
      case 'amend':
        await cmdAmend(values, serverUrl);
        break;
      case 'stop':
        await cmdStop(values, serverUrl);
        break;
      case 'recommend':
        await cmdRecommend(values, serverUrl);
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error('[ollama-swarm] Error:', err.message);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
