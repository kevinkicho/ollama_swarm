param(
  [string]$Root = "C:\Users\kevin\Desktop\ollama_swarm"
)

$ErrorActionPreference = "Continue"
Set-Location $Root

$ts = Get-Date -Format "yyyy-MM-ddTHH-mm-ss"
$logDir = Join-Path $Root "runs\_eval\finish-sweeps-$ts"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$launcherLog = Join-Path $logDir "launcher.log"

function W($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format o), $msg
  Add-Content -Path $launcherLog -Value $line
}

W "=== finish-sweeps started ==="
W "Working dir: $Root"
W "Log dir: $logDir"

# --- Sweep 1B continuation: 7 remaining fixtures + redo extract-pure-helper ---
# Already have: fix-off-by-one (3/3 PASS), add-null-guard (3/3 PASS),
# extract-pure-helper (2/3 FAIL — redoing all 3 for cleanliness).
$only1B = "fixture-extract-pure-helper,fixture-rename-symbol,fixture-fix-failing-test,fixture-add-readme-section,fixture-audit-console-logs,fixture-categorize-deps,fixture-multistep-add-script,fixture-multistep-config-then-test"

W "=== Sweep 1B continuation start ==="
W "  filter: $only1B"
W "  out: runs/_eval/sweep1-blackboard-cont"
$sweep1bLog = Join-Path $logDir "sweep1b-stdout.log"
& node eval/run-eval.mjs `
  --fixture-dir=eval/fixtures `
  --presets=blackboard `
  --seeds=3 `
  --only=$only1B `
  --out=runs/_eval/sweep1-blackboard-cont `
  *>&1 | Tee-Object -FilePath $sweep1bLog | Out-Null
W "=== Sweep 1B continuation finished (exit=$LASTEXITCODE) ==="

# --- Sweep 2: 3 analysis tasks x 3 discussion presets x 3 seeds ---
# Target repo: sindresorhus/got — small, public, README-rich, TypeScript code-bound.
$only2 = "audit-readme-claims,council-architecture-decision,stigmergy-coverage-map"

W "=== Sweep 2 analysis start ==="
W "  filter: $only2"
W "  presets: moa,council,round-robin"
W "  repo: sindresorhus/got"
W "  out: runs/_eval/sweep2-analysis"
$sweep2Log = Join-Path $logDir "sweep2-stdout.log"
& node eval/run-eval.mjs `
  --repo=https://github.com/sindresorhus/got `
  --presets=moa,council,round-robin `
  --only=$only2 `
  --seeds=3 `
  --out=runs/_eval/sweep2-analysis `
  *>&1 | Tee-Object -FilePath $sweep2Log | Out-Null
W "=== Sweep 2 finished (exit=$LASTEXITCODE) ==="

# --- Aggregate across all sweep dirs ---
W "=== Aggregate start ==="
$aggLog = Join-Path $logDir "aggregate-stdout.log"
& node eval/aggregate.mjs `
  runs/_eval/sweep1-baseline `
  runs/_eval/sweep1-blackboard `
  runs/_eval/sweep1-blackboard-cont `
  runs/_eval/sweep2-analysis `
  *>&1 | Tee-Object -FilePath $aggLog | Out-Null
W "=== Aggregate finished (exit=$LASTEXITCODE) ==="

W "=== finish-sweeps DONE ==="
