# Model behavior observations

> Accumulated from production runs. Update when a model does something surprising.
> These are empirical, not speculative — each entry cites a run, commit, or code location.

---

## glm-5.1:cloud

**Role: Default planner** (`config.ts` DEFAULT_MODEL). Reasoning-tier model; ~70s mean turn time.

- **XML pseudo-tool-call drift.** Emits raw `<read>`, `<grep>`, `<bash>` XML tags as text output instead of using proper tool-call channels. Root cause: trained on Anthropic XML examples but given OpenAI-style function-call schemas through the Ollama bridge. Also affects `deepseek-v4-pro`. Claude on the native Anthropic provider produces zero markers — this is exclusive to open-weights models routed through OpenAI-compat bridges. (`project_xml_tool_marker_finding.md`, `extractText.ts:86-96`)
- **` ```json ` markdown fences.** Consistently wraps JSON output in markdown code fences, requiring a strip-before-parse step. (`ConformanceMonitor.test.ts:111`)
- **Empty responses on parallel fanout.** When multiple agents prompt simultaneously, resolves with `data.parts: []`, producing "(empty response)" in transcript. Not a real model refusal — timing artifact. (`project_run_patterns.md` Pattern 5)
- **Context accumulation causes empty responses.** Reusing the planner's session for reflection passes after a full run causes empty output. Fix: use `chatOnce` for fresh sessions. (`reflectionPasses.ts:41-46`)
- **Slow first-byte on large prompts.** Planner has hit the 300s headers timeout on audit prompts large enough that the model couldn't return headers in 5 minutes. Cold-start TTFB occasionally exceeds 90s. (`httpDispatcher.ts:23-26,38-45`)
- **Sibling fallback → `nemotron-3-super:cloud`.** (`BlackboardRunnerConstants.ts:65`)
- **Few-shot hunk mistakes.** Non-unique `search` anchors in hunks caused by multi-line anchors matching the wrong block. Fixed with explicit few-shot examples in worker prompt. (`worker.ts:182-188`)

---

## nemotron-3-super:cloud

**Role: Default auditor** (`config.ts` DEFAULT_AUDITOR_MODEL). Strongest reasoning in the fleet — chosen for cross-criterion synthesis. Higher latency but amortized across infrequent audit invocations.

- **Junk-short responses.** Returns ultra-short non-language output instead of real prose. Observed: `"4"`, hex SHAs, passwd-like strings. Content is non-empty so empty-response retry doesn't catch it. Affects council drafter prompt. (`project_run_patterns.md` Pattern 8, `extractText.ts:225-236`)
- **Raw tool-call protocol leak.** Leaks `<|tool_call_begin|>bash{"command":"npm audit"}<|tool_end|>` tokens into text output — observed 30+ repetitions in degenerate loop. `stripToolCallLeak()` truncates at first marker. (`extractText.ts:86-96`)
- **Intra-stream JSON loop.** Emitted the same JSON tool-call envelope 132 times before SSE-idle watchdog fired. Triggered creation of `intraStreamLoopDetector.ts`. (`intraStreamLoopDetector.ts:5-7`)
- **Bimodal latency.** Most prompts ~5s, but long tail of multi-minute outliers (4 of 32 prompts >4 minutes). Agent-1 council prompt returned real text at 457s. (`project_run_patterns.md` Pattern 11)
- **Safer sibling fallback.** Designated as fallback for both `glm-5.1` and `deepseek-v4-pro`. Deemed "the safer fallback for all three." (`BlackboardRunnerConstants.ts:60-67`)

---

## gemma4:31b-cloud

**Role: Default worker model** (`config.ts` DEFAULT_WORKER_MODEL). Coding-tier, 3-4x faster than reasoning-tier models. ~12s mean turn, p95 ~47s.

- **Best tokens-per-second in the fleet.** Acceptable code-edit quality at much higher throughput. Ideal for diff-generation where speed matters more than reasoning depth. (`config.ts:47-49`)
- **Default brain fallback model.** Used by `SWARM_BRAIN_MODEL` to extract structured JSON from failed rule-based parses. Fast and reliable at extraction. (`config.ts:311-317`, `brainParser.ts:18-30`)
- **Lower discussion quality.** When used for discussion presets, produces lower-quality output than reasoning-tier models. Stigmergy on gemma4 completed in 290s (~3-5x speedup) but stigmergy is a lighter task. (`project_run_patterns.md` Pattern 6, Pattern 11)
- **Few-shot hunk mistakes.** Same non-unique `search` anchor problem as glm-5.1. (`worker.ts:182-188`)

---

## deepseek-v4-pro:cloud

**Status: Unstable.** NOT recommended as planner or auditor.

- **XML pseudo-tool-call drift.** Same issue as glm-5.1 — emits raw XML tool-call markers. (`project_xml_tool_marker_finding.md`)
- **Not chosen as sibling for any model.** Present in `SIBLING_MODELS` only as a target FROM it (if a user explicitly selects it, falls back to nemotron). Never chosen as a sibling FOR glm-5.1 or nemotron — "nemotron is the safer fallback for all three." (`BlackboardRunnerConstants.ts:60-67`)
- **Included in overnight failover chain as middle tier.** `glm-5.1 → deepseek-v4-pro → nemotron-3-super`. (`reference_overnight_run_recommendations.md:10`)

---

## Anthropic provider

- **XML-clean.** Claude on the native Anthropic provider produces zero XML pseudo-tool-call markers. The XML leak is exclusive to open-weights models routed through OpenAI-compat bridges. (`project_xml_tool_marker_finding.md:9-12`)
- **Provider is built-in.** Accessible when `ANTHROPIC_API_KEY` env var is set. The `/api/models?provider=anthropic` endpoint discovers available models via API. (`config.ts:78`, `STATUS.md`)

---

## OpenAI provider

- **Accessible when `OPENAI_API_KEY` is set.** Model discovery via `/api/models?provider=openai` with 24h server-side cache. (`config.ts:79`, `STATUS.md`)

---

## Latency reference

| Model | Role | Mean Turn | p95 | Max Observed |
|---|---|---|---|---|
| `glm-5.1:cloud` | Planner/Auditor | ~70s | — | >300s (header timeout) |
| `nemotron-3-super:cloud` | Auditor/Council | ~58s (mixed) | — | 457s |
| `gemma4:31b-cloud` | Worker | ~12s | 47s | — |

---

## Design rules derived from these observations

1. **Reasoning-tier for planner/auditor; coding-tier for workers.** A single run typically uses glm-5.1 (planner) + gemma4 (workers) + nemotron (auditor). This asymmetric split — cheap+fast workers vs. slow+smart planner — is intentional. (`SwarmRunner.ts:89-90,352-354`)
2. **Sibling retry always goes to a safer model.** `glm-5.1 → nemotron`, `nemotron → glm-5.1` (mutual), `deepseek-v4-pro → nemotron`. DeepSeek is never the sibling FOR anything. (`BlackboardRunnerConstants.ts`)
3. **Brain fallback uses the fastest model.** `gemma4:31b-cloud` — it only does JSON extraction, not reasoning. (`config.ts`)
4. **Open-weights first.** Paid providers (Anthropic, OpenAI) are accessible but not the default. The project's value prop is parallel Ollama models. (`project_value_prop_open_weights_first.md`)
