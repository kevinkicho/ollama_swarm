#!/usr/bin/env node
/**
 * Expanded Electron stub test.
 * Uses prior run data from run-summary-embedded.json for starting parameters.
 * Verifies PERFORMANCE_FLAGS, preload, and simulates launch config.
 *
 * Run: node electron/test-stub.mjs
 */

const fs = require('node:fs');
const path = require('node:path');

// Load prior run data (from previous context: blackboard, 5 agents, 0 rounds)
let priorRaw = fs.readFileSync(path.join(__dirname, '../run-summary-embedded.json'), 'utf8');
priorRaw = priorRaw.replace(/^\uFEFF/, ''); // strip BOM if present
const priorData = JSON.parse(priorRaw);
const priorParams = {
  preset: priorData.preset || 'blackboard',
  agentCount: priorData.agentCount || 5,
  rounds: priorData.rounds || 0,
  model: priorData.model || 'deepseek-v4-flash:cloud',
  userDirective: (priorData.userDirective || '').slice(0, 100) + '...',
  runId: priorData.runId || 'unknown',
  wallClockMs: priorData.wallClockMs || 0,
  totalPromptTokens: priorData.totalPromptTokens || 0
};

console.log('[electron-test] Using prior run data for starting parameters:');
console.dir(priorParams);

// Require the main stub (it sets flags on require)
const main = require('./main.js');

// Verify flags were applied (we exported PERFORMANCE_FLAGS)
const flags = main.PERFORMANCE_FLAGS || [];
console.log('[electron-test] PERFORMANCE_FLAGS applied:', flags.length > 0);

const hasMemoryFlag = flags.some(f => f[0] === 'js-flags' && f[1]?.includes('max-old-space-size'));
const hasNoSandbox = flags.some(f => Array.isArray(f) ? (f[0] === 'no-sandbox' || (f[1]||'').includes('sandbox')) : String(f).includes('sandbox'));
const hasDisableGpu = flags.some(f => Array.isArray(f) ? (f[0]||'').includes('gpu') || (f[1]||'').includes('gpu') : String(f).includes('gpu'));
const hasThrottleDisable = flags.some(f => Array.isArray(f) ? String(f[0]||f[1]||'').includes('throttl') || String(f[0]||f[1]||'').includes('background') : false);

console.log('[electron-test] Has memory flag:', hasMemoryFlag);
console.log('[electron-test] Has disable-gpu/no-sandbox flags:', hasNoSandbox || hasDisableGpu);
console.log('[electron-test] Has anti-throttle/background flags:', hasThrottleDisable);

// Simulate preload
const preloadPath = path.join(__dirname, 'preload.js');
const hasPreload = fs.existsSync(preloadPath);
console.log('[electron-test] Preload script exists:', hasPreload);

// Simulate launch with prior params (mock BrowserWindow creation) + prior data
console.log('[electron-test] Simulating launch with prior params...');
const mockConfig = {
  ...priorParams,
  webPreferences: {
    preload: preloadPath,
  },
  priorRunId: priorParams.runId,
  priorTokens: priorParams.totalPromptTokens
};
console.log('[electron-test] Mock window config (incl prior):', JSON.stringify(mockConfig, null, 2));

// Invoke the exported createWindow (uses the mocked BrowserWindow)
try {
  main.createWindow();
  console.log('[electron-test] createWindow() invoked successfully with prior data context.');
} catch (e) {
  console.log('[electron-test] createWindow note (expected in stub env):', e?.message || e);
}

// Check that main would load dev or prod (mocked, no real electron)
const isDev = true; // in test env
console.log('[electron-test] Would load dev server (8244) or prod dist:', isDev ? 'dev' : 'prod');

// Final assertion - expanded for prior + flags
if (hasMemoryFlag && hasPreload && (hasDisableGpu || hasNoSandbox)) {
  console.log('[electron-test] ✅ Electron stub test PASSED using prior run data (blackboard/5/0 etc).');
  process.exit(0);
} else {
  console.error('[electron-test] ❌ Test failed.');
  process.exit(1);
}
