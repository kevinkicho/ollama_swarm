#!/usr/bin/env node
/**
 * ollama-swarm CLI
 *
 * Control interface for humans and **Brain-OS agents**.
 * Supports the full loop: recommend preset, start, monitor (status), steer (amend), reconfig limits, stop.
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

/** Optional shared secret for SWARM_API_TOKEN-secured servers. */
function authHeaders(extra = {}) {
  const tok = (process.env.SWARM_API_TOKEN || process.env.OLLAMA_SWARM_API_TOKEN || '').trim();
  const h = { 'Content-Type': 'application/json', ...extra };
  if (tok) {
    h['Authorization'] = `Bearer ${tok}`;
    h['X-Swarm-Token'] = tok;
  }
  return h;
}

function printHelp() {
  console.log(`
ollama-swarm — control ollama_swarm from terminal or Brain-OS agents

Commands (full control loop for agents):
  start             Start a swarm (flags or --config from Brain)
  status            Show status (global or --run-id)
  list              List active runs
  amend             Mid-run directive addendum (--run-id + --text)
  reconfig          Extend rounds / wall-clock / token budget
  say               Inject steer/suggest/ask into transcript
  drain             Soft-stop (finish current claims)
  stop              Hard stop (--run-id)
  summary           Fetch run summary (--run-id + --clone-path)
  recommend         Preset recommendation for a directive
  control-surface   Machine-readable API map for Brain agents
  prune-logs        Prune logs/ (and optionally runs/) retention (default dry-run)

Examples for Brain-OS agents:
  ollama-swarm control-surface --json
  ollama-swarm recommend --directive "scan papers and synthesize common properties"
  ollama-swarm start --directive "..." --preset council --web-tools
  ollama-swarm status --run-id abc123
  ollama-swarm amend --run-id abc123 --text "focus on the board todos for X"
  ollama-swarm say --run-id abc123 --text "prioritize tests" --intent steer
  ollama-swarm reconfig --run-id abc123 --extend-wall-clock-min 15
  ollama-swarm drain --run-id abc123
  ollama-swarm stop --run-id abc123
  ollama-swarm summary --run-id abc123 --clone-path "C:\\\\path\\\\to\\\\clone"
  ollama-swarm prune-logs
  ollama-swarm prune-logs --apply
  ollama-swarm prune-logs --target all --apply

Common options:
  --config <file>          JSON config (from Brain chat)
  --directive, -d <text>
  --preset <name>
  --agent-count <n>  --rounds <n>  --model <str>
  --parent-path, --repo-url, --server, --clone-path, --run-id, --text
  --intent suggest|steer|ask  --dry-run  --json  --help
  --apply  --target logs|runs|all|project-logs  --mode prune|purge  (prune-logs)
  --clone-path <path>   (required for --target project-logs)
`);
}

async function startRun(config, serverUrl) {
  const url = `${serverUrl.replace(/\/$/, '')}/api/swarm/start`;

  console.log(`[ollama-swarm] Starting run via ${url} ...`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
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
    ...options,
    headers: authHeaders(options.headers || {}),
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

async function cmdReconfig(values, serverUrl) {
  const runId = values['run-id'] || values.runId;
  if (!runId) {
    console.error('reconfig requires --run-id');
    process.exit(1);
  }
  const patch = { runId };
  if (values['extend-rounds']) patch.extendRounds = Number(values['extend-rounds']);
  if (values['extend-wall-clock-min']) patch.extendWallClockCapMin = Number(values['extend-wall-clock-min']);
  if (values['extend-token-budget']) patch.extendTokenBudget = Number(values['extend-token-budget']);
  if (values.rounds) patch.rounds = Number(values.rounds);
  if (values['wall-clock-min']) patch.wallClockCapMin = Number(values['wall-clock-min']);
  if (values['token-budget']) patch.tokenBudget = Number(values['token-budget']);
  const hasField = Object.keys(patch).length > 1;
  if (!hasField) {
    console.error('reconfig requires at least one limit flag (e.g. --extend-wall-clock-min 15)');
    process.exit(1);
  }
  const url = `${serverUrl.replace(/\/$/, '')}/api/swarm/reconfig`;
  const res = await fetchJson(url, { method: 'POST', body: JSON.stringify(patch) });
  console.log('✅ Limits updated:', res.message || res);
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

async function cmdDrain(values, serverUrl) {
  const runId = values['run-id'] || values.runId;
  if (!runId) {
    console.error('drain requires --run-id');
    process.exit(1);
  }
  const url = `${serverUrl.replace(/\/$/, '')}/api/swarm/drain`;
  await fetchJson(url, { method: 'POST', body: JSON.stringify({ runId }) });
  console.log(`✅ Drain requested for ${runId}`);
}

async function cmdSay(values, serverUrl) {
  const runId = values['run-id'] || values.runId;
  const text = values.text || values.directive;
  if (!runId || !text) {
    console.error('say requires --run-id and --text');
    process.exit(1);
  }
  const intent = values.intent || 'steer';
  const url = `${serverUrl.replace(/\/$/, '')}/api/swarm/say`;
  const body = { runId, text, intent };
  if (values['target-agent']) body.targetAgent = values['target-agent'];
  const res = await fetchJson(url, { method: 'POST', body: JSON.stringify(body) });
  console.log('✅ Say injected:', res);
}

async function cmdList(values, serverUrl) {
  const url = `${serverUrl.replace(/\/$/, '')}/api/swarm/active-runs`;
  const data = await fetchJson(url);
  if (values.json) {
    console.log(JSON.stringify(data));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function cmdSummary(values, serverUrl) {
  const runId = values['run-id'] || values.runId;
  const clonePath = values['clone-path'];
  if (!runId || !clonePath) {
    console.error('summary requires --run-id and --clone-path');
    process.exit(1);
  }
  const q = new URLSearchParams({ runId, clonePath });
  const url = `${serverUrl.replace(/\/$/, '')}/api/swarm/run-summary?${q}`;
  const data = await fetchJson(url);
  if (values.json) {
    console.log(JSON.stringify(data));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function cmdControlSurface(values, serverUrl) {
  const url = `${serverUrl.replace(/\/$/, '')}/api/swarm/brain/control-surface`;
  const data = await fetchJson(url);
  if (values.json) {
    console.log(JSON.stringify(data));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
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

async function cmdPruneLogs(values, serverUrl) {
  const base = serverUrl.replace(/\/$/, '');
  if (values['dry-run'] && values.apply) {
    console.error('prune-logs: use either --apply or --dry-run, not both');
    process.exit(1);
  }
  // Default dry-run unless --apply
  const apply = values.apply === true;
  const target = values.target || 'logs';
  const mode = values.mode || 'prune';
  const clonePath = values['clone-path'];
  if (target === 'project-logs' && !clonePath) {
    console.error('prune-logs --target project-logs requires --clone-path');
    process.exit(1);
  }
  const body = { target, apply, mode };
  if (clonePath) body.clonePath = clonePath;
  if (values['keep-days'] != null) body.keepDays = Number(values['keep-days']);
  if (values['max-keep'] != null) body.maxKeep = Number(values['max-keep']);

  if (!apply) {
    let statusUrl = `${base}/api/swarm/maintenance/status`;
    if (clonePath) statusUrl += `?clonePath=${encodeURIComponent(clonePath)}`;
    const status = await fetchJson(statusUrl);
    if (!values.json) {
      console.log(
        `[app] logs run dirs: ${status.logsRunDirCount}` +
          (status.logsNeedsPrune ? ' (over threshold)' : '') +
          `; runs entries: ${status.runsEntryCount}`,
      );
      if (status.project) {
        console.log(
          `[project] ${status.project.root}: ${status.project.logsRunDirCount} run dirs, ` +
            `${status.project.summaryFileCount} summary files` +
            (status.project.logsNeedsPrune ? ' (prune recommended)' : ''),
        );
      }
    }
  }

  const url = `${base}/api/swarm/maintenance/prune`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  if (values.json) {
    console.log(JSON.stringify(data));
  } else {
    console.log(data.summary || JSON.stringify(data, null, 2));
    if (!apply) {
      console.log(
        'Tip: add --apply to delete. Project logs: --target project-logs --clone-path "C:\\\\path\\\\to\\\\repo" [--mode purge]',
      );
    }
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
      'extend-rounds': { type: 'string' },
      'extend-wall-clock-min': { type: 'string' },
      'extend-token-budget': { type: 'string' },
      'wall-clock-min': { type: 'string' },
      'token-budget': { type: 'string' },
      text: { type: 'string' },
      intent: { type: 'string' },
      'target-agent': { type: 'string' },
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      target: { type: 'string' },
      mode: { type: 'string' },
      'keep-days': { type: 'string' },
      'max-keep': { type: 'string' },
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
      case 'list':
        await cmdList(values, serverUrl);
        break;
      case 'amend':
        await cmdAmend(values, serverUrl);
        break;
      case 'reconfig':
        await cmdReconfig(values, serverUrl);
        break;
      case 'say':
        await cmdSay(values, serverUrl);
        break;
      case 'drain':
        await cmdDrain(values, serverUrl);
        break;
      case 'stop':
        await cmdStop(values, serverUrl);
        break;
      case 'summary':
        await cmdSummary(values, serverUrl);
        break;
      case 'recommend':
        await cmdRecommend(values, serverUrl);
        break;
      case 'control-surface':
      case 'control_surface':
        await cmdControlSurface(values, serverUrl);
        break;
      case 'prune-logs':
      case 'prune_logs':
      case 'prune':
        await cmdPruneLogs(values, serverUrl);
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
