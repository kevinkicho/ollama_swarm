#!/usr/bin/env bash
# Smoke tour: 8 swarm presets sequentially against one repo.
# Each run capped at the per-preset safety timeout (default 30 min).
# #137 quota detection is the safety net for Ollama walls.
#
# Usage: smoke-tour.sh <repo-url> <directive> <label> [proposition]
#
# Outputs:
#   /tmp/smoke-tour-<label>-progress.json  (per-preset rows)
#   /tmp/smoke-tour-<label>.log            (human-readable progress)
#
# Bug fixes from 2026-04-25 tour (Task #148):
#   - curl -m bumped 60 → 300s so spawn-warmup with #137 quota walls
#     no longer times out client-side
#   - wait_until_idle WARNING messages now go to stderr (not tee'd to
#     stdout) so they don't pollute captured `final_phase`
#   - quota-state probe rewritten as a here-doc to a separate python
#     file so f-string escaping in heredoc-from-bash can't silently
#     fail (the prior version returned empty on certain payloads,
#     hitting the false-quota-warning path and adding 5min sleep
#     between every preset)
#   - per-preset safety_s (Task #157) — council/OW/OW-deep/etc get
#     tighter caps than blackboard/role-diff/debate-judge
#   - force=true on /api/swarm/start (Task #147) — recovers from any
#     stuck-orchestrator state without manual intervention
set -uo pipefail   # not -e: keep going if one preset fails

REPO_URL="${1:?repo url required}"
DIRECTIVE="${2:?directive required}"
LABEL="${3:?label required}"
PROPOSITION="${4:-This project is well-suited to its target users and ready for the next investment.}"

SERVER="http://127.0.0.1:52243"
PARENT_PATH="/mnt/c/Users/kevin/Desktop/ollama_swarm/runs"
CHECKPOINT="/tmp/smoke-tour-${LABEL}-progress.json"
LOG="/tmp/smoke-tour-${LABEL}.log"

# Per-preset rows: name | agentCount | rounds | safety_s. The safety_s
# field (Task #157) replaces the prior global SAFETY_TIMEOUT_S=2700 —
# council typically finishes in 14 min so 1500s is generous; blackboard
# can use the full 30-min wall-clock cap + post-cap cleanup tail so
# 2700s. role-diff / debate-judge get 2700s because they don't have an
# in-runner wall-clock cap (only token-budget gates them).
PRESETS=(
  "blackboard|4|20|2700"
  "role-diff|5|30|2700"
  "council|4|30|1500"
  "orchestrator-worker|5|12|1800"
  "orchestrator-worker-deep|8|6|1800"
  "debate-judge|3|40|2700"
  "map-reduce|5|12|1800"
  "stigmergy|4|30|1800"
)

mkdir -p "$(dirname "$CHECKPOINT")"
echo "[]" > "$CHECKPOINT"

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG"
}
# Task #148 fix: WARNINGs from inside a $(...) capturable function
# must NOT use tee to stdout, or they'll pollute the captured value.
# stderr is fine — visible in the log file via 2>&1 redirection at
# script-call time, and not captured by command substitution.
warn() {
  printf '[%s] WARNING %s\n' "$(date '+%H:%M:%S')" "$*" >&2
  printf '[%s] WARNING %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG"
}

build_payload() {
  local preset="$1" agents="$2" rounds="$3"
  python3 - "$REPO_URL" "$PARENT_PATH" "$preset" "$agents" "$rounds" "$DIRECTIVE" "$PROPOSITION" <<'PYEOF'
import json, sys
repo, parent, preset, agents, rounds, directive, proposition = sys.argv[1:8]
payload = {
    "repoUrl": repo,
    "parentPath": parent,
    "preset": preset,
    "agentCount": int(agents),
    "rounds": int(rounds),
    "userDirective": directive,
    # Task #147: force-restart any stuck orchestrator from a prior
    # half-failed start. Cheap insurance — if the orchestrator is
    # healthy the stop call is a no-op.
    "force": True,
}
if preset == "blackboard":
    payload["wallClockCapMs"] = 1800000
if preset == "debate-judge":
    payload["proposition"] = proposition
print(json.dumps(payload))
PYEOF
}

# Task #148 fix: extract quota probe into a dedicated python script
# rather than wedging it into a bash heredoc. The prior inline version
# could return an empty string on certain JSON shapes (no quota field
# present, server returned an unexpected structure), which then hit
# the `if [ "$quota_state" != "none" ]` warning branch — causing 5-min
# false sleeps between every preset.
quota_probe() {
  curl -s -m 5 "$SERVER/api/usage" 2>/dev/null \
    | python3 -c '
import json, sys
try:
  d = json.load(sys.stdin)
except Exception:
  print("none"); sys.exit(0)
q = d.get("quota")
if q is None:
  print("none"); sys.exit(0)
status = q.get("statusCode") if isinstance(q, dict) else "?"
reason = (q.get("reason") if isinstance(q, dict) else "")[:80]
kind = q.get("kind") if isinstance(q, dict) else "?"
print(f"{status}|{kind}|{reason}")
'
}

wait_until_idle() {
  local preset_safety_s="$1"
  local deadline=$(( $(date +%s) + preset_safety_s ))
  while true; do
    local status_json
    status_json=$(curl -s -m 10 "$SERVER/api/swarm/status" 2>/dev/null || echo '{"phase":"unknown"}')
    local phase
    phase=$(printf '%s' "$status_json" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("phase","unknown"))
except: print("parse_error")')
    case "$phase" in
      idle|completed|stopped|failed)
        echo "$phase"; return 0;;
    esac
    if [ "$(date +%s)" -gt "$deadline" ]; then
      warn "safety timeout ${preset_safety_s}s exceeded — sending /stop"
      curl -s -m 30 -X POST "$SERVER/api/swarm/stop" -H 'Content-Type: application/json' >/dev/null 2>&1
      sleep 10; echo "timeout"; return 0
    fi
    sleep 30
  done
}

append_checkpoint() {
  python3 - <<EOF
import json
with open("$CHECKPOINT") as f: data = json.load(f)
data.append($1)
with open("$CHECKPOINT", "w") as f: json.dump(data, f, indent=2)
EOF
}

log "==== smoke tour: $LABEL ($REPO_URL) ===="
log "Directive: $DIRECTIVE"
log "Checkpoint: $CHECKPOINT"

for row in "${PRESETS[@]}"; do
  IFS='|' read -r preset agents rounds safety_s <<< "$row"
  log "---- $preset (agents=$agents rounds=$rounds safety=${safety_s}s) ----"

  payload=$(build_payload "$preset" "$agents" "$rounds")
  if [ -z "$payload" ]; then
    log "  payload build FAILED — skipping"
    continue
  fi

  start_ts=$(date +%s)
  # Task #148 fix: bump curl timeout 60 → 300s. Spawn-warmup during
  # active 429 wall can take 2-3 min as #153's 200ms-per-agent stagger
  # works through the queue. Without the bump, the script gives up
  # while server-side spawn keeps running.
  start_response=$(curl -s -m 300 -X POST "$SERVER/api/swarm/start" \
    -H 'Content-Type: application/json' --data-raw "$payload" 2>&1)
  start_ok=$(printf '%s' "$start_response" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print("ok" if d.get("ok") else d.get("error","unknown"))
except: print("parse_error")' 2>/dev/null)
  if [ "$start_ok" != "ok" ]; then
    log "  start FAILED: $start_ok"
    log "  raw: $(printf '%s' "$start_response" | head -c 300)"
    append_checkpoint "{\"preset\":\"$preset\",\"status\":\"start_failed\",\"reason\":$(printf '%s' "$start_ok" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))'),\"ts\":$start_ts}"
    sleep 5
    continue
  fi
  log "  started — waiting for completion (safety=${safety_s}s)..."

  final_phase=$(wait_until_idle "$safety_s")
  end_ts=$(date +%s)
  wall=$((end_ts - start_ts))
  log "  done — phase=$final_phase wall=${wall}s"

  final_json=$(curl -s -m 10 "$SERVER/api/swarm/status" 2>/dev/null || echo '{}')
  run_id=$(printf '%s' "$final_json" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("runId",""))
except: print("")')
  quota_state=$(quota_probe)

  append_checkpoint "{\"preset\":\"$preset\",\"agents\":$agents,\"rounds\":$rounds,\"phase\":\"$final_phase\",\"wall_s\":$wall,\"runId\":\"$run_id\",\"quota\":\"$quota_state\",\"ts\":$start_ts}"

  # Task #148 fix: only sleep on PERSISTENT quota walls (#149 distinction).
  # Concurrency walls clear in seconds; no need to wait 5 min.
  if [[ "$quota_state" == *"persistent"* ]]; then
    warn "ollama persistent quota wall hit ($quota_state) — pausing 5 min before next preset"
    sleep 300
  else
    sleep 15  # let kill-all stragglers finish
  fi
done

log "==== smoke tour COMPLETE: $LABEL ===="
log "See $CHECKPOINT for per-run summaries"
