# Smoke tour digest — 2026-04-25

**Goal**: validate all 8 swarm presets sequentially against 2 repos (debate-tcg, vocabmaster-android) using fresh code from the autonomous-mode roadmap (#124-#139).

**Outcome**: half-complete tour, 6 bugs surfaced, 1 fixed live (#144), 3 of 8 debate-tcg presets produced genuinely useful output. Vocabmaster blackboard run still in flight at digest time.

**Time budget**: planned ~8h, cratered at ~4h due to a 429 concurrency wall + cascading orchestrator-lock bug.

---

## Final preset results

### debate-tcg

| # | Preset | Outcome | Wall | Useful artifacts |
|---|---|---|---|---|
| 1 | blackboard | ✅ completed | 44m46s | 4 commits to `RoomManager.js` + `gameEngine.js`; 4-bullet lesson set in `.swarm-memory.jsonl` |
| 2 | role-diff | ⚠ safety-timeout at round 10/30 | 45m00s | Partial transcript; convergence detector misfired (#141) |
| 3 | council | ✅ early-stop converged-high at round 15/30 | 13m39s | Clean cross-drafter synthesis |
| 4 | OW (flat) | ⚠ completed but 5/12 cycles dead-loop | 44m41s | 7 useful cycles before context bloat caused empty plans (#144 root-caused + fixed) |
| 5 | OW-deep | ✅ 6 clean cycles | 19m10s | First end-to-end validation of #131. 3-tier hierarchy worked, mid-leads consolidated worker reports correctly |
| 6 | debate-judge | ⚠ safety-timeout at round 17/40 | 45m00s | 14 productive rounds before same dead-loop pattern as #144 (#146 queued) |
| 7 | map-reduce | ❌ start-failed | — | Hit 429 concurrency wall during spawn-warmup |
| 8 | stigmergy | ❌ "already running" | — | Couldn't start because failed map-reduce left orchestrator locked |

### vocabmaster-android

| # | Preset | Outcome |
|---|---|---|
| 1 | blackboard | 🔄 in flight at digest time (runId `4c2aa3a0`) — script's 60s curl timeout was too short during 429-throttled spawn, but server-side it's running normally |
| 2-8 | (all) | ❌ "already running" — orchestrator was busy with vocabmaster blackboard when each was attempted |

---

## What worked

### Real product work (blackboard on debate-tcg)
The 4 commits + 4 honest lessons are the only "did the swarm act on the directive?" evidence we have. Lessons paraphrased:
1. `NEWS_CYCLES` constant + `_triggerNewsCycleEvent` method are dead code — `playCard` still calls the old `_triggerRandomEvent`
2. Two `_applyEffect` methods with different signatures will silently shadow each other
3. `schema.json` has a `tags` field for combo-synergy but no logic reads it — combo mechanic is "one tier away"
4. Seven backend systems are invisible because `index.html` / `UIManager.js` / `CardRenderer.js` were never updated; HUD work should precede more backend systems

This is exactly what #129 (stretch) + #130 (memory) were built to capture. **A future blackboard run on the same clone would auto-read these lessons in its planner seed and avoid re-doing dead-code work.**

### Council clean early-stop
13m39s, converged-high at the midpoint synthesis. Exactly as designed.

### OW-deep first run
8 agents through orchestrator → mid-leads → workers → mid-synth → orch-synth, 6 cycles in 19 min, no anomalies. **#131 is validated end-to-end.**

### Cap firings (proven)
- Wall-clock cap (#116 fix) fired at 30 min on blackboard ✓
- Token-budget cap (#124) — not hit because we removed the cap per direction
- Quota wall (#137) — caught the 429 cleanly, surfaced reason via `/api/usage`
- Safety timeout (smoke-tour script) — caught role-diff and debate-judge

---

## What broke

### Bugs surfaced (in severity order)

| # | Bug | Status | Severity |
|---|---|---|---|
| #144 | OW dead-loop: empty-response placeholder → 0 assignments → "skipping execute phase" → next cycle, 5 cycles ate 27 min | ✅ **FIXED in `7240f5d`** | High |
| NEW-1 | Start-failure leaves orchestrator locked: failed map-reduce start kept `this.runner` set → all subsequent starts hit "A swarm is already running" | pending | High |
| NEW-2 | Smoke-tour `curl -m 60` too short during spawn-warmup with active 429 wall → silent timeout misclassified as "start FAILED" | pending | Medium |
| #146 | Same dead-loop pattern as #144 in debate-judge (and likely council, map-reduce, stigmergy) — fix applies to all looping presets | pending | High |
| #141 | role-diff convergence detector didn't fire (run reached round 10/30 without "converged-high") | pending | Medium |
| #143 | role-diff token rate volatility 14M → 43M → back; possibly junk-loop retries | pending | Low |
| #142 | stale "thinking" status marker past 4-min absolute cap | pending | Low (cosmetic) |
| #147 | quota detector doesn't distinguish transient concurrency-429 from persistent usage-429 — flag stays set even after Ollama un-throttles | pending | Medium |

### Smoke-tour script bugs (cosmetic, surfaced earlier)

- False "ollama quota wall hit ()" with empty parens between every preset — 5min wasted sleep × 7 presets per repo = ~35 min added to tour time
- Checkpoint JSON misses entries when `wait_until_idle` returns multi-line output (`tee` pollutes captured stdout)

---

## Token consumption

- **Lifetime tokens at digest time**: 46.3M
- **Quota walls hit**: 1 (concurrency, not usage). Detected and reported via `/api/usage.quota`. Did not consume Ollama plan tokens.
- **Per-preset budget peak**: role-diff round 4-10 spiked to 43M tokens/hr — investigation queued (#143)
- **Most efficient preset**: council (early-stop, 13m wall, ~3M tokens for converged synthesis)
- **Least efficient**: OW (45m wall, ~half wasted in dead-loop — fixed by #144)

---

## What this tour did NOT measure

- **Cross-preset quality comparison**: only blackboard writes persistent artifacts via #130. Other 7 presets are invisible to disk-based tools. **#148 would close this** by extending memory writes to all presets + adding a 1-line score per run.
- **Repeated runs of the same preset**: each preset got 1 attempt per repo. Variance unknown.
- **vocabmaster results for any preset besides blackboard** (in-flight).

---

## Recommended next steps

### Immediate (after vocabmaster blackboard finishes)
1. Run a "completion tour" for the 7 missed vocabmaster presets + 2 missed debate-tcg presets (map-reduce, stigmergy). ETA ~5h with the script bugs fixed.
2. Before that tour: ship the script fixes (#150 below) so we don't waste another ~70 min on false-quota-wall sleeps.

### Code follow-ups (queued as TaskList entries)
- **NEW-1 → task**: orchestrator-lock-on-failed-start bug
- **NEW-2 → task**: smoke-tour script fix (curl timeouts + JSON parse + wait_until_idle output bleed)
- #146: extend #144 fix to debate-judge / council / map-reduce / stigmergy
- #147: transient vs persistent 429 classification
- #148: cross-preset memory + auto-score extraction

### Investigation follow-ups (queued)
- #141, #142, #143 (already in task list)

---

_Source data: `/tmp/smoke-tour-debate-tcg.log`, `/tmp/smoke-tour-vocabmaster-android.log`, `/tmp/smoke-tour-debate-tcg-progress.json`, `/tmp/smoke-tour-vocabmaster-android-progress.json`, summary-`*`.json files in each clone, `.swarm-memory.jsonl` on debate-tcg._

_Live data: refresh `/tmp/smoke-tour-comparison.md` via `bash /tmp/smoke-tour-compare.sh`._
