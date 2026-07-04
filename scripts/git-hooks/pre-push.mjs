#!/usr/bin/env node
/**
 * Git pre-push hook.
 *
 * Runs the full local CI verification (same gates as GitHub Actions)
 * before allowing a push. This prevents the classic "it worked locally
 * but CI is red" loop.
 *
 * To install:
 *   node scripts/install-git-hooks.mjs
 *
 * To bypass (emergency only):
 *   git push --no-verify
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

console.log('\n[pre-push] Running local CI verification before push...\n');

const result = spawnSync('node', ['scripts/verify-ci.mjs'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  console.error('\n[pre-push] ❌ verify-ci failed. Push aborted.');
  console.error('Fix the issues above, or use `git push --no-verify` only in emergencies.\n');
  process.exit(result.status || 1);
}

console.log('\n[pre-push] ✅ All CI gates passed. Pushing...\n');
process.exit(0);
