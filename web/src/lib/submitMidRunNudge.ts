/** POST a mid-run directive nudge to the active server run (not the viewed runId). */

export interface MidRunNudgeAmendment {
  ts: number;
  text: string;
}

export interface SubmitMidRunNudgeResult {
  ok: true;
  activeRunId: string;
  amendment: MidRunNudgeAmendment;
}

export async function submitMidRunNudge(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitMidRunNudgeResult> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Nudge text is empty");
  }

  const statusRes = await fetchImpl("/api/swarm/status");
  if (!statusRes.ok) {
    throw new Error(`Server status: HTTP ${statusRes.status}`);
  }
  const status = (await statusRes.json()) as { runId?: string };
  const activeRunId = status.runId?.trim();
  if (!activeRunId) {
    throw new Error("No active run on server");
  }

  const res = await fetchImpl("/api/swarm/amend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId: activeRunId, text: trimmed }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  const body = (await res.json()) as { amendment?: MidRunNudgeAmendment };
  const amendment = body.amendment;
  if (!amendment || typeof amendment.text !== "string") {
    throw new Error("Server accepted nudge but returned no amendment");
  }

  return { ok: true, activeRunId, amendment };
}