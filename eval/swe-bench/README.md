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
- `--swe-bench-dataset=<path>` flag on `run-eval.mjs` — loads + adapts the dataset, with companion `--swe-bench-task=<id>`, `--swe-bench-limit=<N>`, and `--swe-bench-dry-run` flags for filtering and previewing
- Dry-run mode (`--swe-bench-dry-run`) — prints which tasks would be executed (compatible vs env-incompatible-skipped) and exits

## Quick verify (no real dataset needed)

```bash
# Use the synthetic sample.jsonl — 2 fabricated tasks
node eval/run-eval.mjs \
  --swe-bench-dataset=eval/swe-bench/sample.jsonl \
  --swe-bench-dry-run

# Filter to one task
node eval/run-eval.mjs \
  --swe-bench-dataset=eval/swe-bench/sample.jsonl \
  --swe-bench-task=express__express-1 \
  --swe-bench-dry-run

# Limit to first N tasks
node eval/run-eval.mjs \
  --swe-bench-dataset=eval/swe-bench/sample.jsonl \
  --swe-bench-limit=1 \
  --swe-bench-dry-run
```

## What's NOT in this slice (queued)

- **Aggregate report comparing our pass-rate to the published per-model baselines table** — adds an `eval/swe-bench/RESULTS.md` builder that reads our results.json + a hand-curated table of "GPT-4 = 33%, Sonnet = 49%, Devin = 13%" etc. and renders side-by-side. ~2h after Docker is wired.
- **Image pre-pulling orchestration** — `docker pull` for each task's image takes minutes and gigabytes. A pre-pull script that runs before the sweep would parallelize the downloads.

## Docker test execution (#100, 2026-05-01)

Docker-based test execution is now available via `eval/swe-bench/dockerExecutor.mjs`:

```bash
# Per-task verify, mocked (no Docker actually invoked):
node --test eval/swe-bench/dockerExecutor.test.mjs
```

The executor:
- Bind-mounts the staged repo at `/workspace` inside the container
- Runs `--network none` so tests can't accidentally exfiltrate
- Applies the SWE-Bench `test_patch` via `git apply` then runs the test command
- Distinguishes 4 outcome reasons in `runSweBenchVerify`: `tests-passed` / `tests-failed` / `patch-conflict` / `docker-unavailable` / `timeout`
- Default 10-min timeout per task; configurable via `timeoutMs`
- Dependency-injected `dockerSpawn` for testability — production uses `node:child_process.spawn("docker", ...)`, tests inject mocks

**Real-Docker validation (Kevin's laptop-side step):** the executor's
behavior against actual Docker images cannot be CI-validated here
since SWE-Bench images aren't available in CI. To smoke-test:

```bash
# 1. Make sure docker is running + you've pulled an SWE-Bench image
docker pull swebench/sweb.eval.x86_64.astropy_1776:latest

# 2. Stage a repo at the right base_commit (the eval harness does this normally)
git clone https://github.com/astropy/astropy /tmp/astropy
cd /tmp/astropy && git checkout <base_commit>

# 3. Run a smoke test using the executor directly:
node -e "
import('/c/Users/kevin/Desktop/ollama_swarm/eval/swe-bench/dockerExecutor.mjs')
  .then(async ({ executeInContainer }) => {
    const r = await executeInContainer({
      image: 'swebench/sweb.eval.x86_64.astropy_1776:latest',
      repoPath: '/tmp/astropy',
      command: 'echo hello from inside container',
      timeoutMs: 30000,
    });
    console.log(r);
  });
"
```

Wiring `executeInContainer` into the eval harness's verify step is the
last mile — the executor is ready, the harness just needs to call it
when a task is env-incompatible-but-Docker-available. That's a follow-
up: ~1h once Kevin confirms the executor works against real images.
