#!/usr/bin/env bash
# autoresearch-watchdog.sh — external watchdog that keeps autoresearch alive.
#
# Run this from a SEPARATE terminal alongside your main opencode session:
#   bash scripts/autoresearch-watchdog.sh
#
# It polls .opencode/session-checkpoint.md every 10s. When status is
# in_progress, it spawns `opencode run` to continue the work. When
# status is finished, it exits.
#
# Key difference from the plugin: this runs OUTSIDE opencode, so there's
# no session lifecycle deadlock. Each `opencode run` invocation creates
# a fresh session context with the autoresearch skill loaded.

set -euo pipefail

CHECKPOINT=".opencode/session-checkpoint.md"
MAX_IDLE_SECONDS=60

echo "[watchdog] Watching $CHECKPOINT for autoresearch..."

consecutive_idle=0
while true; do
  if [[ ! -f "$CHECKPOINT" ]]; then
    echo "[watchdog] Checkpoint missing — exiting."
    exit 0
  fi

  status=$(grep -oP '^> Status:\s*\*{2}\K\w+' "$CHECKPOINT" 2>/dev/null || echo "unknown")

  if [[ "$status" == "finished" ]]; then
    echo "[watchdog] Status is finished — exiting."
    exit 0
  fi

  if [[ "$status" != "in_progress" ]]; then
    sleep 10
    continue
  fi

  # Status is in_progress. Wait a bit for the previous session to
  # fully settle (avoid spawning while opencode is still processing).
  echo "[watchdog] Status in_progress, waiting for idle..."
  sleep 10

  # Re-read status — if it changed during our wait, loop back.
  status=$(grep -oP '^> Status:\s*\*{2}\K\w+' "$CHECKPOINT" 2>/dev/null || echo "unknown")
  if [[ "$status" != "in_progress" ]]; then
    consecutive_idle=0
    continue
  fi

  consecutive_idle=$((consecutive_idle + 1))
  if (( consecutive_idle < 2 )); then
    # First idle after status change — wait one more cycle to let
    # the previous session fully complete.
    sleep 10
    continue
  fi

  echo "[watchdog] Running autoresearch..."
  opencode run --dangerously-skip-permissions "autoresearch" || true
  consecutive_idle=0
  sleep 5
done
