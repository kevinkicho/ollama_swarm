# Phase 3 verification helper.
# Usage (from the project root, after `npm run dev` is running):
#   .\scripts\poke-blackboard.ps1
#   .\scripts\poke-blackboard.ps1 -Port 52243
#   .\scripts\poke-blackboard.ps1 -LocalPath C:\Users\kevin\Workspace\is-odd-bb
param(
    [int]$Port = 52243,
    [string]$RepoUrl = "https://github.com/kevinkicho/multi-agent-orchestrator",
    [string]$LocalPath = "C:\Users\kevin\Workspace\mao-bb",
    [int]$AgentCount = 1,
    [string]$Model = "glm-5.1:cloud",
    [string]$Preset = "blackboard"
)

$params = @{
    repoUrl    = $RepoUrl
    localPath  = $LocalPath
    agentCount = $AgentCount
    model      = $Model
    preset     = $Preset
}
$body = $params | ConvertTo-Json -Compress
$uri = "http://localhost:$Port/api/swarm/start"

Write-Host "POST $uri"
Write-Host "body: $body"
Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType application/json
