// 2026-05-02: LLM-as-judge for analysis-task quality scoring.
//
// Sweep 2 v2 surfaced the measurement gap: every discussion preset
// (moa, council, round-robin) scored 91-95 on every analysis task
// because the existing throughput component just rewards transcript
// volume — not actual output quality. With this judge wired in, the
// quality dimension comes from a dedicated model evaluating the
// final synthesis against a per-task rubric.
//
// Design:
//   - Per-task rubric authored in catalog.json's `qualityRubric` field.
//   - Judge model invoked via the SAME Ollama endpoint the swarm uses
//     (defaults to deepseek-v4-flash:cloud — strongest reasoning that
//     ships free). Configurable via --quality-judge-model on the CLI.
//   - Judge sees: task description, rubric, the agent's final
//     synthesis (last 3000 chars of transcript prefer the synthesis
//     bubble; falls back to last system summary entry).
//   - Output: {score: 0-100, rationale: "<one sentence>"}.
//   - Failure handling: silent — if judge call fails, score=null and
//     run-eval scores the run as if no rubric existed (back-compat
//     with non-rubric tasks).
//
// This module is pure JS (.mjs) so the existing eval harness can
// import without TS shenanigans. Pure builders are tested separately.

const DEFAULT_JUDGE_MODEL = "deepseek-v4-flash:cloud";
const FINAL_SYNTHESIS_MAX_CHARS = 3000;

/** Build the judge prompt. Pure — tested in isolation. */
export function buildJudgePrompt({ taskDescription, rubric, agentOutput }) {
  return [
    "You are a quality judge evaluating an AI agent's analysis output.",
    "Be honest. A response that just restates the task scores low. A response that engages substantively with the codebase and produces specific, actionable findings scores high.",
    "Most real analyses score 40-70. A 90+ is rare and means the response is genuinely insightful AND well-grounded.",
    "",
    `TASK: ${taskDescription}`,
    "",
    "RUBRIC (each dimension contributes; weight by your judgment):",
    rubric,
    "",
    "AGENT'S RESPONSE (final synthesis from the swarm — judge ONLY this):",
    "--- BEGIN ---",
    agentOutput.slice(-FINAL_SYNTHESIS_MAX_CHARS),
    "--- END ---",
    "",
    'Output ONE JSON object on a single line, no prose: {"score": <integer 0-100>, "rationale": "<one sentence, under 150 chars>"}',
  ].join("\n");
}

/** Parse judge output. Pure — tested in isolation.
 *  Returns null when the response can't be parsed (caller scores as
 *  no-judge). */
export function parseJudgeOutput(raw) {
  if (!raw || typeof raw !== "string") return null;
  // Strip ```json fences if present.
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  // Find the first balanced {...} so we can ignore prose around it.
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  let parsed;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const score = Number(parsed.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) return null;
  const rationale =
    typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 200) : "";
  return { score: Math.round(score), rationale };
}

/** Extract the agent's final synthesis from a summary.json's transcript.
 *  Strategy: prefer the LAST agent-role entry (typically the aggregator's
 *  synthesis); fall back to the last system-role entry (some runners
 *  surface their final result in a system message); final fallback is
 *  the empty string. Pure — tested in isolation. */
export function extractFinalSynthesis(summary) {
  if (!summary?.transcript?.length) return "";
  const transcript = summary.transcript;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.role === "agent" && e.text && e.text.length > 50) {
      return e.text;
    }
  }
  // Fallback: last substantive system entry
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.role === "system" && e.text && e.text.length > 50) {
      return e.text;
    }
  }
  return "";
}

/** 2026-05-02 (matrix row #7): multi-judge inter-rater check.
 *  Run the SAME deliverable through N judges (different models),
 *  return per-judge scores + an agreement stat. Lets us know whether
 *  a "score 75" run is robustly 75 across raters or whether judges
 *  wildly disagree (in which case the score is suspect).
 *
 *  Returns:
 *    perJudge: [{model, score, rationale}, ...]
 *    agreement: "high" | "medium" | "low" — based on max-min spread
 *    summary: averaged score (mean of available judges) + spread
 *  Returns null when ALL judges fail. */
export async function multiJudgeAnalysisRun({
  task,
  summary,
  ollamaBaseUrl,
  models,
  fetchImpl = fetch,
}) {
  if (!Array.isArray(models) || models.length === 0) return null;
  const results = await Promise.all(
    models.map(async (m) => {
      const r = await judgeAnalysisRun({ task, summary, ollamaBaseUrl, model: m, fetchImpl });
      return r ? { model: m, ...r } : null;
    }),
  );
  const valid = results.filter((r) => r !== null);
  if (valid.length === 0) return null;
  const scores = valid.map((r) => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const mean = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const spread = max - min;
  // Agreement bucket: ≤10 spread = high, 11-25 = medium, ≥26 = low.
  // The judge prompt explicitly says "most analyses score 40-70";
  // a 30-point spread between judges on the same artifact is a sign
  // the judges are using different mental rubrics, not noise on a
  // shared one.
  const agreement = spread <= 10 ? "high" : spread <= 25 ? "medium" : "low";
  return {
    perJudge: valid,
    agreement,
    meanScore: mean,
    spread,
    judgeCount: valid.length,
  };
}

/** Run the judge against an analysis task's output.
 *  Returns {score: 0-100, rationale: string} on success, null on
 *  ANY failure (network, parse, missing rubric, etc.). The caller
 *  scores the run as no-judge in the null case. */
export async function judgeAnalysisRun({
  task,
  summary,
  ollamaBaseUrl,
  model = DEFAULT_JUDGE_MODEL,
  fetchImpl = fetch,
}) {
  if (!task?.qualityRubric || typeof task.qualityRubric !== "string") return null;
  const agentOutput = extractFinalSynthesis(summary);
  if (!agentOutput) return null;
  const prompt = buildJudgePrompt({
    taskDescription: task.directive ?? task.id ?? "",
    rubric: task.qualityRubric,
    agentOutput,
  });
  const url = `${ollamaBaseUrl.replace(/\/$/, "")}/api/chat`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        format: "json",
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const content = body?.message?.content;
  if (!content || typeof content !== "string") return null;
  return parseJudgeOutput(content);
}
