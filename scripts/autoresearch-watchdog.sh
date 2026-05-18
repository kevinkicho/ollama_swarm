#!/usr/bin/env bash
# autoresearch-watchdog.sh — bulletproof external autoresearch loop.
#
# Watches .opencode/session-checkpoint.md. When status is in_progress,
# spawns `opencode run "autoresearch"` as a fresh session.
# Tracks cycles with timestamps. Exits when status transitions to finished.
#
# Run from a separate terminal:
#   bash scripts/autoresearch-watchdog.sh

set -euo pipefail

CHECKPOINT=".opencode/session-checkpoint.md"
COOLDOWN=10
MAX_RETRIES=3

info()  { echo "[watchdog] $(date +%H:%M:%S) $*"; }
warn()  { echo "[watchdog] $(date +%H:%M:%S) WARN: $*" >&2; }

[[ -f "$CHECKPOINT" ]] || { warn "No $CHECKPOINT — exiting."; exit 1; }

info "Autoresearch watchdog started (cooldown=${COOLDOWN}s)"
info "Polling $CHECKPOINT..."

cycle=0
start_time=$(date +%s)

update_watchdog_section() {
  local ts="$1" c="$2" rc="$3" elapsed="$4"
  if [[ -f "$CHECKPOINT" ]]; then
    sed -i '/^## Watchdog/,/^##/d' "$CHECKPOINT"
    cat >> "$CHECKPOINT" <<WATCHDOG

## Watchdog
| Cycle | Time | Duration | Result |
|-------|------|----------|--------|
| $c | $ts | ${elapsed}s | $([[ $rc -eq 0 ]] && echo "OK" || echo "FAIL (exit=$rc)") |

WATCHDOG
  fi
}

while true; do
  if [[ ! -f "$CHECKPOINT" ]]; then
    warn "Checkpoint deleted — exiting."
    exit 1
  fi

  status=$(grep -oP '^> Status:\s*\*{2}\K\w+' "$CHECKPOINT" 2>/dev/null || echo "")

  case "$status" in
    finished)
      info "STATUS=FINISHED — exiting."
      exit 0
      ;;

    in_progress)
      cycle=$((cycle + 1))
      cycle_start=$(date +%s)
      info "CYCLE #$cycle — running autoresearch..."
      update_watchdog_section "$(date +%H:%M:%S)" "$cycle" 0 0

      ok=false
      for attempt in $(seq 1 $MAX_RETRIES); do
        if [[ $attempt -gt 1 ]]; then
          warn "CYCLE #$cycle attempt $attempt/$MAX_RETRIES..."
          sleep 5
        fi

        set +e
        opencode run --dangerously-skip-permissions "autoresearch" 2>&1
        rc=$?
        set -e

        if [[ $rc -eq 0 ]]; then
          ok=true
          break
        fi
        warn "CYCLE #$cycle attempt $attempt failed (exit=$rc)"
      done

      cycle_elapsed=$(($(date +%s) - cycle_start))
      if $ok; then
        info "CYCLE #$cycle DONE in ${cycle_elapsed}s"
        update_watchdog_section "$(date +%H:%M:%S)" "$cycle" 0 "$cycle_elapsed"
      else
        warn "CYCLE #$cycle FAILED after $MAX_RETRIES attempts"
        update_watchdog_section "$(date +%H:%M:%S)" "$cycle" 1 "$cycle_elapsed"
      fi

      sleep "$COOLDOWN"
      ;;

    *)
      sleep "$COOLDOWN"
      ;;
  esac
done
