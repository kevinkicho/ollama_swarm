import { createHybridSwarm } from '../src/hybrid-swarm.mjs';
import { waitForState } from '../src/utils.mjs';

async function main() {
  const swarm = await createHybridSwarm({
    planners: 3,
    brain: false,
    transcriptGap: 0.1,
  });
  await swarm.start();
  await swarm.stop();
  const state = swarm.getState();
  if (state === 'stopped') {
    console.log('PASS');
  } else {
    console.log('FAIL: state is ' + state);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
