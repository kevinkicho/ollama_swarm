# Eval harness — preset × task scoreboard (#297)

Runs every (preset, task) pair from `catalog.json` against a target repo, scores each run from its `summary.json`, and produces a comparison matrix. The ollama_swarm-specific equivalent of SWE-bench / AgentBench.

## Why

Without a measurement substrate you're guessing whether code changes (a new prompt template, a routing tweak, an extra agent role) make the system better or worse. With this you can re-run the eval after every meaningful change and watch the matrix move.

## Usage

```bash
# Make sure the dev server is up + idle first.
node eval/run-eval.mjs \
  --repo=https://github.com/kevinkicho/multi-agent-orchestrator
```

Optional flags:
- `--catalog=<path>` — alternate catalog file (default `eval/catalog.json`)
- `--out=<dir>` — output directory (default `runs/_eval/<timestamp>/`)
- `--server=<url>` — backend base URL (default `http://127.0.0.1:8243`)
- `--parent=<dir>` — parent dir for clones (default `runs/_eval-clones/`)
- `--only=<task-id,...>` — run only specific tasks
- `--presets=<preset,...>` — restrict to specific presets

A full sweep (4 tasks × ~3-5 presets each ≈ 15-20 runs at 5-10 min each) takes 2-4 hours. Use `--only` for spot-checks.

## Output

In `<out>/`:
- `REPORT.md` — preset × task score matrix + per-run breakdown + per-preset aggregates
- `results.json` — machine-readable rows (one per attempt)
- `per-run/<task>__<preset>__<ts>.json` — captured `summary.json` for each completed run
- `progress.log` — human-readable timeline

## Scoring (0-100 per run)

- **completion** (40 pts): `completed`=40, `user`/`wall_clock`=20, `failed`=0
- **throughput** (30 pts): code tasks scale on `filesChanged`; analysis tasks on transcript length
- **efficiency** (20 pts): tokens-per-minute, full points under 50k
- **conformance** (10 pts): reserved for #295 aggregation; currently neutral 5

`pass rate` in aggregates = % of runs scoring ≥ 60.

## Adding tasks

Each task in `catalog.json`:

```json
{
  "id": "unique-slug",
  "title": "Human-readable",
  "directive": "What the swarm should do (passed as userDirective)",
  "presets": ["preset-1", "preset-2"],
  "rounds": 2,
  "agentCount": 4,
  "wallClockCapMs": 600000,
  "expectFilesChanged": false,
  "$rationale": "Why this task / which preset shape it tests"
}
```

For debate-judge tasks add `"proposition": "..."`. Optional `$comment` / `$rationale` fields are ignored by the harness but help future readers understand intent.

Keep tasks small — under 10 min per preset is the sweet spot. Anything longer dominates the sweep budget without adding signal.
