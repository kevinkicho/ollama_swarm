# Phase 3/4 verification helper.
# POSTs /api/swarm/start with the blackboard preset, then polls /api/swarm/status
# until the run terminates (completed, stopped, or error) or -WaitSeconds elapses.
# Prints the server-side event log path at the end so Claude can read it directly.
#
# Usage (from the project root, after `npm run dev` is running):
#   .\scripts\poke-blackboard.ps1
#   .\scripts\poke-blackboard.ps1 -AgentCount 3
#   .\scripts\poke-blackboard.ps1 -Port 8243 -NoWait
param(
    [int]$Port = 8243,
    [string]$RepoUrl = "https://github.com/kevinkicho/multi-agent-orchestrator",
    [string]$LocalPath = "C:\Users\kevin\Workspace\mao-bb",
    [int]$AgentCount = 1,
    [string]$Model = "glm-5.1:cloud",
    [string]$Preset = "blackboard",
    [int]$WaitSeconds = 600,
    [int]$PollSeconds = 2,
    [switch]$NoWait
)

$ErrorActionPreference = "Stop"

$params = @{
    repoUrl    = $RepoUrl
    localPath  = $LocalPath
    agentCount = $AgentCount
    model      = $Model
    preset     = $Preset
}
$body = $params | ConvertTo-Json -Compress
$startUri = "http://localhost:$Port/api/swarm/start"
$statusUri = "http://localhost:$Port/api/swarm/status"

Write-Host "POST $startUri"
Write-Host "body: $body"
$startResp = Invoke-RestMethod -Method Post -Uri $startUri -Body $body -ContentType application/json
Write-Host "start accepted: phase=$($startResp.status.phase)"

if ($NoWait) {
    Write-Host "--no-wait set; exiting. Poll $statusUri manually."
    return
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$lastPhase = ""
$terminal = @("completed", "stopped", "failed")

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $PollSeconds
    try {
        $s = Invoke-RestMethod -Method Get -Uri $statusUri
    } catch {
        Write-Warning "status poll failed: $($_.Exception.Message)"
        continue
    }
    if ($s.phase -ne $lastPhase) {
        $ts = (Get-Date).ToString("HH:mm:ss")
        Write-Host "[$ts] phase -> $($s.phase)  (transcript: $($s.transcript.Count) entries)"
        $lastPhase = $s.phase
    }
    if ($terminal -contains $s.phase) {
        break
    }
}

# Resolve the canonical log path. Server prints it on startup but it is also
# deterministic: <repoRoot>\logs\current.jsonl.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$logPath = Join-Path $repoRoot "logs\current.jsonl"

Write-Host ""
Write-Host "=== final status ==="
Write-Host "phase: $lastPhase"
Write-Host "transcript entries: $($s.transcript.Count)"
if ($s.agents) { Write-Host "agents: $($s.agents.Count)" }
Write-Host ""
Write-Host "event log: $logPath"
if (Test-Path $logPath) {
    $lines = (Get-Content $logPath | Measure-Object -Line).Lines
    Write-Host "(log has $lines line(s))"
} else {
    Write-Warning "log file not found — server may not have wired the logger."
}
