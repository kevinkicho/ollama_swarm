# Multi-provider scoreboard

**Generated:** 2026-05-02 from `runs/_eval/sweep1-baseline + runs/_eval/sweep1-blackboard + runs/_eval/sweep1-blackboard-cont + runs/_eval/sweep2-analysis-v2`
**Attempts:** 89 runs across 14 tasks × 5 presets

Cell format: `median (p25-p75) · passCount/attempts`. "Pass" = score ≥ 60 AND the run finished cleanly. Lower IQR = more consistent preset behavior.

| Task | baseline | blackboard | council | moa | round-robin |
| --- | ---: | ---: | ---: | ---: | ---: |
| **audit-readme-claims** | — | 0 (0–0) · 0/3 | 95 (95–95) · 3/3 | 95 (95–95) · 3/3 | 91 (91–91) · 3/3 |
| **council-architecture-decision** | — | — | 95 (95–95) · 3/3 | 95 (95–95) · 3/3 | — |
| **fix-todos** | — | 0 (0–0) · 0/3 | — | — | — |
| **fixture-add-null-guard** | 50 (50–50) · 0/3 | 115 (115–121) · 3/3 | — | — | — |
| **fixture-add-readme-section** | 50 (50–50) · 0/3 | 127 (72–127) · 2/3 | — | — | — |
| **fixture-audit-console-logs** | 0 (0–0) · 0/3 | 127 (72–127) · 2/3 | — | — | — |
| **fixture-categorize-deps** | 0 (0–0) · 0/3 | 121 (121–124) · 3/3 | — | — | — |
| **fixture-extract-pure-helper** | 0 (0–0) · 0/3 | 47 (47–47) · 0/5 | — | — | — |
| **fixture-fix-failing-test** | 0 (0–0) · 0/3 | 127 (127–127) · 3/3 | — | — | — |
| **fixture-fix-off-by-one** | 0 (0–0) · 0/3 | 127 (127–127) · 3/3 | — | — | — |
| **fixture-multistep-add-script** | 0 (0–0) · 0/3 | 127 (127–127) · 3/3 | — | — | — |
| **fixture-multistep-config-then-test** | 0 (0–0) · 0/3 | 47 (29–87) · 1/3 | — | — | — |
| **fixture-rename-symbol** | 0 (0–0) · 0/3 | 47 (47–87) · 1/3 | — | — | — |
| **stigmergy-coverage-map** | — | — | — | 95 (95–95) · 3/3 | 95 (95–95) · 3/3 |

## Per-preset summary

| Preset | Median across tasks | Pass rate |
| --- | ---: | ---: |
| baseline | 0 | 0% (0/30) |
| blackboard | 118 | 55% (21/38) |
| council | 95 | 100% (6/6) |
| moa | 95 | 100% (9/9) |
| round-robin | 93 | 100% (6/6) |

## How to reproduce

```bash
# 1. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in .env
# 2. Start the dev server: npm run dev
# 3. Run the sweep (5 seeds × every preset × every task in catalog):
node eval/run-eval.mjs --repo=https://github.com/<your/target> --seeds=5
# 4. Aggregate the results:
node eval/aggregate.mjs runs/_eval/<timestamp>
```

Numbers above are not absolute. They are a comparative ranking of presets on the same fixture set with the same model. Move the model + the fixture set and the table changes — pick presets for *your* task class, not by copying these.