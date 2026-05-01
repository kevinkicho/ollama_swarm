# SWE-Bench Lite integration

This directory wires our eval harness to ingest [SWE-Bench Lite](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite) — Princeton's curated set of 300 real GitHub issues from scikit-learn, matplotlib, sympy, etc. Running our open-weights swarm against these tasks produces numbers directly comparable to published baselines (GPT-4, Devin, OpenHands, Aider, Claude).

## How it works

Each SWE-Bench task is a JSON object with:
- `instance_id`: e.g. `astropy__astropy-12907`
- `repo`: `astropy/astropy`
- `base_commit`: SHA the issue was filed against
- `problem_statement`: the GitHub issue text
- `patch`: the gold patch that was eventually merged (for scoring only)
- `test_patch`: how to verify a candidate fix (also for scoring only)

Our adapter (`adapter.mjs`) converts each SWE-Bench task into the fixture-mode shape the existing eval harness already understands:
1. Clone `repo` at `base_commit` into a fresh staging dir
2. Use `problem_statement` as the swarm's `userDirective`
3. Run any preset (blackboard recommended)
4. After the run, apply `test_patch` and run the relevant test command — exit-0 = PASS, otherwise FAIL
5. Score against the same scoreRun() the existing eval already uses, plus a +50 bonus when the test passes

## Setup

```bash
# 1. Download SWE-Bench Lite from HuggingFace (~5MB JSONL)
mkdir -p eval/swe-bench/dataset
curl -L -o eval/swe-bench/dataset/lite.jsonl \
  https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite/resolve/main/test-00000-of-00001.jsonl

# Or use the parquet → jsonl conversion if HF only ships parquet:
# pip install pandas pyarrow
# python -c "import pandas as pd; pd.read_parquet('test.parquet').to_json('lite.jsonl', orient='records', lines=True)"
```

`eval/swe-bench/dataset/` is gitignored — the dataset doesn't ship in this repo. You're responsible for the download.

## Running a single task

```bash
node eval/run-eval.mjs \
  --swe-bench-task=astropy__astropy-12907 \
  --swe-bench-dataset=eval/swe-bench/dataset/lite.jsonl \
  --presets=blackboard \
  --seeds=1 \
  --model=glm-5.1:cloud \
  --out=runs/_eval/swe-bench-astropy12907
```

## Running a sweep

```bash
node eval/run-eval.mjs \
  --swe-bench-dataset=eval/swe-bench/dataset/lite.jsonl \
  --swe-bench-limit=10 \
  --presets=blackboard \
  --seeds=1 \
  --model=glm-5.1:cloud \
  --out=runs/_eval/swe-bench-sample-10
```

`--swe-bench-limit=N` runs the first N tasks. Use sparingly; each task can take 5-15 min on blackboard.

## Limitations of this slice

- **No Docker isolation.** The official SWE-Bench harness runs each task's tests inside a versioned Docker image; we run against your local Node + git. Some tasks have native deps (numpy / scipy via pip) that won't be installable in this env. Adapter SKIPS such tasks with a clear "skipped: env-incompatible" verdict so the sweep doesn't choke on them.
- **Test-patch application is best-effort.** The `test_patch` is meant to apply CLEANLY against `base_commit`. If the swarm's edits collide with the test patch's hunks, the test stage records "patch-conflict" and the task is excluded from pass-rate stats.
- **Comparable, not directly comparable.** Published numbers (e.g. Sonnet 4.6 = 49% on Lite) come from the official Docker harness. Our pass-rate uses our local execution path. Order-of-magnitude comparable but expect drift on env-sensitive tasks.

## What this slice ships today

- `adapter.mjs` — pure adapter that converts a SWE-Bench task JSON into the catalog-entry shape `run-eval.mjs` already understands
- `adapter.test.mjs` — covers happy path, missing fields, env-incompatible classification
- `sample.jsonl` — 2 synthetic tasks (NOT real SWE-Bench data — just shape examples) so you can run the harness end-to-end without downloading the real dataset

## What's NOT in this slice (queued)

- Wiring `--swe-bench-dataset` flag into `run-eval.mjs`'s arg parser (~1h)
- Docker-based test execution (a future evolution; for now, we trust the local Node env or skip)
- Aggregate report comparing our pass-rate to the published per-model baselines table
