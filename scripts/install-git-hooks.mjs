#!/usr/bin/env node
/**
 * Installs git hooks for this project.
 *
 * Currently installs:
 * - pre-push → runs `npm run verify-ci` (full local CI parity)
 *
 * Run this manually or via `npm run prepare` / `npm install`.
 *
 * It is safe to run multiple times.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const gitDir = path.join(projectRoot, '.git');
const hooksDir = path.join(gitDir, 'hooks');

if (!fs.existsSync(gitDir)) {
  console.log('No .git directory found. Skipping git hook installation.');
  console.log('(This is normal in some CI or submodule environments.)');
  process.exit(0);
}

if (!fs.existsSync(hooksDir)) {
  fs.mkdirSync(hooksDir, { recursive: true });
}

const hookName = 'pre-push';
const sourceHook = path.join(projectRoot, 'scripts', 'git-hooks', 'pre-push.mjs');
const targetHook = path.join(hooksDir, hookName);

// Content for the actual hook file placed in .git/hooks
// We use a small portable wrapper so it works on Windows + Unix.
const hookContent = `#!/bin/sh
# Git pre-push hook installed by scripts/install-git-hooks.mjs
# Runs the project verify-ci script (mirrors GitHub Actions).

node "$(dirname "$0")/../../scripts/git-hooks/pre-push.mjs" "$@"
`;

try {
  fs.writeFileSync(targetHook, hookContent, { mode: 0o755 });

  // On Windows, also ensure a .cmd wrapper exists for some Git setups
  if (process.platform === 'win32') {
    const cmdWrapper = path.join(hooksDir, `${hookName}.cmd`);
    const cmdContent = `@echo off\r\nnode "%~dp0..\\..\\scripts\\git-hooks\\pre-push.mjs" %*\r\n`;
    fs.writeFileSync(cmdWrapper, cmdContent);
  }

  // Try to make executable on Unix-like systems (including Git Bash)
  try {
    fs.chmodSync(targetHook, 0o755);
  } catch {}

  console.log(`✅ Installed git hook: ${hookName}`);
  console.log(`   Source: ${path.relative(projectRoot, sourceHook)}`);
  console.log(`   Target: ${path.relative(projectRoot, targetHook)}`);
  console.log('\nThe hook will run `npm run verify-ci` on every push.');
  console.log('To bypass: git push --no-verify (use sparingly)\n');
} catch (err) {
  console.error('Failed to install git hook:', err.message);
  console.error('You can run the verification manually with: npm run verify-ci');
  // Do not fail the whole npm install for this
  process.exit(0);
}
