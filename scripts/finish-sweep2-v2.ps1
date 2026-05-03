param(
  [string]$Root = "C:\Users\kevin\Desktop\ollama_swarm"
)

$ErrorActionPreference = "Continue"
Set-Location $Root

$ts = Get-Date -Format "yyyy-MM-ddTHH-mm-ss"
$logDir = Join-Path $Root "runs\_eval\finish-sweep2-v2-$ts"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$launcherLog = Join-Path $logDir "launcher.log"

function W($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format o), $msg
  Add-Content -Path $launcherLog -Value $line
}

W "=== finish-sweep2-v2 started ==="
W "Root: $Root"
W "Log dir: $logDir"

# --- Sweep 2 v2: 3 analysis tasks x 3 presets x 3 seeds against sindresorhus/got ---
# v2 because v1's MoA cells were bogus (MoaRunner missing writeSummary). Fixed
# in this session; re-running fresh to a new out dir so the aggregator only
# sees real data.
$only2 = "audit-readme-claims,council-architecture-decision,stigmergy-coverage-map"

W "=== Sweep 2 v2 start ==="
W "  filter: $only2"
W "  presets: moa,council,round-robin"
W "  repo: sindresorhus/got"
W "  out: runs/_eval/sweep2-analysis-v2"
$sweep2Log = Join-Path $logDir "sweep2-stdout.log"
& node eval/run-eval.mjs `
  --repo=https://github.com/sindresorhus/got `
  --presets=moa,council,round-robin `
  --only=$only2 `
  --seeds=3 `
  --out=runs/_eval/sweep2-analysis-v2 `
  *>&1 | Tee-Object -FilePath $sweep2Log | Out-Null
W "=== Sweep 2 v2 finished (exit=$LASTEXITCODE) ==="

# --- Aggregate across all VALID sweep dirs (excludes the bogus sweep2-analysis v1) ---
W "=== Aggregate start ==="
$aggLog = Join-Path $logDir "aggregate-stdout.log"
& node eval/aggregate.mjs `
  runs/_eval/sweep1-baseline `
  runs/_eval/sweep1-blackboard `
  runs/_eval/sweep1-blackboard-cont `
  runs/_eval/sweep2-analysis-v2 `
  *>&1 | Tee-Object -FilePath $aggLog | Out-Null
W "=== Aggregate finished (exit=$LASTEXITCODE) ==="

W "=== finish-sweep2-v2 DONE ==="
