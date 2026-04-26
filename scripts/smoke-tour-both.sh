#!/usr/bin/env bash
# Run the smoke tour against two repos sequentially. Single Orchestrator
# constraint means we can't run them in parallel without spinning up two
# server instances on different ports — see project notes for that
# trade-off. Sequential is the simpler default.
#
# Edit the REPOS array below to point at your targets.
set -uo pipefail

LOG=/tmp/smoke-tour-both.log
HERE="$(cd "$(dirname "$0")" && pwd)"
log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG"; }

log "BOTH-REPOS smoke tour starting"

# Repo 1
log "Repo 1: debate-tcg (~4h estimated)"
"$HERE/smoke-tour.sh" \
  "https://github.com/kevinkicho/debate-tcg" \
  "please add more game objectives, and introduce more entertaining game mechanics, to induce human users to feel more attached to usa politics of today and future, while providing much fun and joy of playing a trading card game. plesae model the game after 'hearthstone','slay the spire', and many other that you think are relevant to our game." \
  "debate-tcg" \
  "This trading card game's mechanics make players genuinely engaged with USA political themes."

log "Repo 1 done — moving to repo 2"
sleep 30  # buffer between repos

# Repo 2
log "Repo 2: vocabmaster-android (~4h estimated)"
"$HERE/smoke-tour.sh" \
  "https://github.com/kevinkicho/vocabmaster-android" \
  "please provide smooth modern user experience fit for android mobile phone and tablet experiences and please come up with interesting learning games and ai-powered contents please." \
  "vocabmaster-android" \
  "This Android vocab app delivers a smooth modern UX competitive with Duolingo and Anki."

log "BOTH-REPOS smoke tour COMPLETE"
log "Per-repo checkpoints: /tmp/smoke-tour-debate-tcg-progress.json and /tmp/smoke-tour-vocabmaster-android-progress.json"
log "Comparator: bash $HERE/smoke-tour-compare.sh"
