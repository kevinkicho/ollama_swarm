#!/usr/bin/env node
/**
 * Local CI parity checker.
 *
 * Runs (almost) exactly the same gates as .github/workflows/ci.yml so you
 * catch failures *before* pushing.
 *
 * Usage:
 *   node scripts/verify-ci.mjs
 *
 * Exit code 1 on any failure. Prints clear step names.
 */

import { spawnSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const steps = [
  {
    name: 'Type-check (server + web + shared)',
    cmd: 'npm',
    args: ['run', 'typecheck'],
    env: {},
  },
  {
    name: 'Run test suite (shared + server)',
    cmd: 'npm',
    args: ['test'],
    env: { OPENCODE_SERVER_PASSWORD: 'test-only' },
  },
  {
    name: 'Verify BlackboardRunner field discovery is current',
    cmd: 'npx',
    args: ['tsx', 'server/scripts/discover-runner-fields.ts', '--check'],
    env: {},
  },
  {
    name: 'Verify prompt assertions (drift check)',
    cmd: 'npx',
    args: ['tsx', 'eval/drift-check.ts'],
    env: {},
  },
  {
    name: 'Verify production build succeeds',
    cmd: 'npm',
    args: ['run', 'build'],
    env: {},
  },
];

function run(step) {
  console.log(`\n=== ${step.name} ===`);
  const result = spawnSync(step.cmd, step.args, {
    stdio: 'inherit',
    env: { ...process.env, ...step.env },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`\n❌ FAILED: ${step.name}`);
    process.exit(result.status || 1);
  }
  console.log(`✅ ${step.name}`);
}

console.log('Running local CI verification (matching GitHub Actions)...\n');

// --- Untracked source guard (common cause of "Cannot find module" in CI) ---
try {
  const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('node_modules'));
  if (untracked.length > 0) {
    console.error('\n❌ Untracked TypeScript source files detected:');
    untracked.forEach((f) => console.error('   ' + f));
    console.error('\nRun `git add` on them (or add to .gitignore) before pushing.');
    console.error('This is the #1 cause of "Cannot find module" failures on CI.\n');
    process.exit(1);
  }
} catch (e) {
  // If git is not available or other issue, don't block the rest of verify.
}

for (const step of steps) {
  run(step);
}

console.log('\n🎉 All CI gates passed locally. Safe to commit/push.');
process.exit(0);
