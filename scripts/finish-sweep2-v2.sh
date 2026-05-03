#!/bin/bash
# Sweep 2 v2 launcher (bash version — sandbox-friendly).
# Re-runs the analysis sweep after fixing MoaRunner.writeSummary.
# v1's MoA cells captured stale council seed3 data because MoaRunner
# never wrote summary.json. Fixed in this session; running fresh.

set -u  # bail on unset vars; do NOT set -e (we want aggregate to run even if eval errors)
cd /c/Users/kevin/Desktop/ollama_swarm

ts=$(date +%Y-%m-%dT%H-%M-%S)
log_dir="runs/_eval/finish-sweep2-v2-$ts"
mkdir -p "$log_dir"
launcher_log="$log_dir/launcher.log"

W() { echo "[$(date -u +%FT%TZ)] $1" | tee -a "$launcher_log"; }

W "=== finish-sweep2-v2 started ==="
W "Log dir: $log_dir"

W "=== Sweep 2 v2 start ==="
W "  filter: audit-readme-claims,council-architecture-decision,stigmergy-coverage-map"
W "  presets: moa,council,round-robin"
W "  repo: sindresorhus/got"
W "  out: runs/_eval/sweep2-analysis-v2"

node eval/run-eval.mjs \
  --repo=https://github.com/sindresorhus/got \
  --presets=moa,council,round-robin \
  --only=audit-readme-claims,council-architecture-decision,stigmergy-coverage-map \
  --seeds=3 \
  --out=runs/_eval/sweep2-analysis-v2 \
  > "$log_dir/sweep2-stdout.log" 2>&1
W "=== Sweep 2 v2 finished (exit=$?) ==="

W "=== Aggregate start ==="
node eval/aggregate.mjs \
  runs/_eval/sweep1-baseline \
  runs/_eval/sweep1-blackboard \
  runs/_eval/sweep1-blackboard-cont \
  runs/_eval/sweep2-analysis-v2 \
  > "$log_dir/aggregate-stdout.log" 2>&1
W "=== Aggregate finished (exit=$?) ==="

W "=== finish-sweep2-v2 DONE ==="
