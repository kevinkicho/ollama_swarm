/**
 * Reproduction script for stop-buttons-hybrid scenario.
 * 
 * Dependencies:
 * - ../src/hybrid-swarm.mjs
 * - ../src/utils.mjs
 * 
 * Run: node scripts/repro-stop-buttons-hybrid.mjs
 */
import { createHybridSwarm } from '../src/hybrid-swarm.mjs';
import { waitForState } from '../src/utils.mjs';

async function main() {
  const response = await fetch('http://localhost:3000/api/hybrid/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planners: 3, brain: false, transcriptGap: 0.1 })
  });
  if (!response.ok) {
    console.error('Failed to start hybrid run:', response.statusText);
    process.exit(1);
  }
  const data = await response.json();
  const runId = data.runId;
  console.log('Run ID:', runId);
  const stopResponse = await fetch(`http://localhost:3000/api/hybrid/stop/${runId}`, {
    method: 'POST'
  });
  if (!stopResponse.ok) {
    console.error('Failed to stop hybrid run:', stopResponse.statusText);
    process.exit(1);
  }
  const stopData = await stopResponse.json();
  if (stopData.state === 'stopped') {
    console.log('PASS');
  } else {
    console.log('FAIL: state is ' + stopData.state);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
