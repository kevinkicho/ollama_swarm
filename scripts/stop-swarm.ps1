param([int]$Port = 8243)
Invoke-RestMethod -Method Post -Uri "http://localhost:$Port/api/swarm/stop"
