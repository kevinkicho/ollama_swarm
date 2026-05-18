#!/usr/bin/env bash
# autoresearch-watchdog.sh — bulletproof external autoresearch loop.
#
# Watches .opencode/session-checkpoint.md. When status is in_progress,
# spawns `opencode run "autoresearch"` as a fresh session. Tracks cycles.
# Exits when status transitions to finished.
#
# Each cycle creates a NEW opencode session. The checkpoint file is the
# only state that persists between cycles. This avoids OpenCode's
# in-process session lifecycle deadlock entirely.

set -euo pipefail

CHECKPOINT=".opencode/session-checkpoint.md"
COOLDOWN=10
OPENCODE_ARGS="${OPENCODE_ARGS:---dangerously-skip-permissions}"

info()  { echo "[watchdog] $(date +%H:%M:%S) $*"; }
warn()  { echo "[watchdog] $(date +%H:%M:%S) WARN: $*" >&2; }

[[ -f "$CHECKPOINT" ]] || { warn "No $CHECKPOINT — exiting."; exit 1; }

info "Autoresearch watchdog started (cooldown=${COOLDOWN}s)"
info "Polling $CHECKPOINT..."

cycle=0
start_time=$(date +%s)

while true; do
  if [[ ! -f "$CHECKPOINT" ]]; then
    warn "Checkpoint deleted — exiting."
    exit 1
  fi

  status=$(grep -oP '^> Status:\s*\*{2}\K\w+' "$CHECKPOINT" 2>/dev/null || echo "")

  case "$status" in
    finished)
      elapsed=$(($(date +%s) - start_time))
      info "STATUS=FINISHED after $cycle cycle(s) in ${elapsed}s — exiting."
      exit 0
      ;;

    in_progress)
      cycle=$((cycle + 1))
      cycle_start=$(date +%s)
      info "CYCLE #$cycle — running autoresearch..."

      set +e
      opencode run $OPENCODE_ARGS "autoresearch" 2>&1 | while IFS= read -r line; do
        echo "[opencode] $line"
      done
      rc=$?
      set -e

      cycle_elapsed=$(($(date +%s) - cycle_start))
      if [[ $rc -eq 0 ]]; then
        info "CYCLE #$cycle DONE in ${cycle_elapsed}s"
      else
        warn "CYCLE #$cycle FAILED after ${cycle_elapsed}s (exit=$rc) — retrying"
      fi

      # Re-read status in case the agent changed it
      sleep "$COOLDOWN"
      ;;

    *)
      sleep "$COOLDOWN"
      ;;
  esac
done
