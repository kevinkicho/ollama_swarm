# Multi-provider scoreboard

**Status:** Pending first sweep.

This file is overwritten by `eval/aggregate.mjs` after a multi-seed sweep. Once published it will show median scores (with IQR) for every preset on every fixture, plus pass rates.

## How to reproduce (once a sweep has run)

```bash
# 1. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in .env
# 2. Start the dev server: npm run dev
# 3. Run the sweep (5 seeds × every preset × every task in eval/catalog.json):
node eval/run-eval.mjs --repo=https://github.com/<your/target> --seeds=5
# 4. Aggregate:
node eval/aggregate.mjs runs/_eval/<timestamp>
```

## Why no published numbers yet

The Phase 6 fixture catalog ships with 3 starter tasks (the framework is proven; the next 7 fixtures are queued — see `eval/fixtures/README.md`). Once the catalog grows enough to be representative AND a paid-provider sweep has run, this file will land with real numbers.

Until then: pick presets for *your* task class, not by trusting any single benchmark. The architecture decisions (when to use blackboard vs council vs orchestrator-worker vs baseline) live in `docs/swarm-patterns.md`.
