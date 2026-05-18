#!/usr/bin/env bash
# autoresearch-watchdog.sh — keeps autoresearch alive from outside opencode.
#
# Run from a SEPARATE terminal alongside opencode:
#   bash scripts/autoresearch-watchdog.sh
#
# Polls checkpoint every 15s. When in_progress, spawns opencode run.
# Exits when status is finished.
#
# Advantage over plugin: runs OUTSIDE opencode, avoiding session lifecycle
# deadlock. Each opencode run creates a fresh session with the skill loaded.

CHECKPOINT=".opencode/session-checkpoint.md"
COOLDOWN=15

[[ -f "$CHECKPOINT" ]] || { echo "[watchdog] No checkpoint file — exiting."; exit 1; }

echo "[watchdog] Polling $CHECKPOINT every ${COOLDOWN}s..."

while true; do
  status=$(grep -oP '^> Status:\s*\*{2}\K\w+' "$CHECKPOINT" 2>/dev/null || echo "")

  case "$status" in
    finished)
      echo "[watchdog] Status finished — exiting."
      exit 0
      ;;
    in_progress)
      echo "[watchdog] Running autoresearch..."
      opencode run --dangerously-skip-permissions "autoresearch" || true
      echo "[watchdog] Cycle complete, cooling down ${COOLDOWN}s..."
      sleep "$COOLDOWN"
      ;;
    *)
      sleep "$COOLDOWN"
      ;;
  esac
done
