param([int]$Port = 52243)
Invoke-RestMethod -Method Post -Uri "http://localhost:$Port/api/swarm/stop"
