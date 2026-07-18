import { extractJsonFromText } from "@ollama-swarm/shared/extractJson";
import type {
  BrainDispatchStatus,
  BrainEffect,
  BrainDispatchResult,
} from "@ollama-swarm/shared/brainOs";
import { randomUUID } from "node:crypto";

function asStatus(v: unknown): BrainDispatchStatus {
  if (
    v === "resolved"
    || v === "partial"
    || v === "blocked"
    || v === "needs_human"
  ) {
    return v;
  }
  return "blocked";
}

function asEffects(raw: unknown): BrainEffect[] {
  if (!Array.isArray(raw)) return [{ type: "none" }];
  const out: BrainEffect[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const type = String(o.type ?? "");
    switch (type) {
      case "board_complete":
      case "board_skip":
        if (typeof o.todoId === "string") {
          out.push({
            type,
            todoId: o.todoId,
            reason: String(o.reason ?? type),
          });
        }
        break;
      case "board_reopen":
        if (typeof o.todoId === "string") {
          out.push({
            type: "board_reopen",
            todoId: o.todoId,
            reason: typeof o.reason === "string" ? o.reason : undefined,
          });
        }
        break;
      case "append_system":
        if (typeof o.text === "string" && o.text.trim()) {
          out.push({ type: "append_system", text: o.text.slice(0, 2000) });
        }
        break;
      case "request_apply":
        out.push({
          type: "request_apply",
          todoId: typeof o.todoId === "string" ? o.todoId : undefined,
        });
        break;
      case "recommend_drain":
        out.push({ type: "recommend_drain" });
        break;
      case "recommend_stop":
        out.push({
          type: "recommend_stop",
          reason: String(o.reason ?? "brain-os recommend stop"),
        });
        break;
      case "propose_hunks":
        if (
          typeof o.todoId === "string"
          && Array.isArray(o.hunks)
          && Array.isArray(o.files)
        ) {
          out.push({
            type: "propose_hunks",
            todoId: o.todoId,
            hunks: o.hunks,
            files: o.files.map(String),
          });
        }
        break;
      case "board_post_todos":
        if (Array.isArray(o.todos)) {
          const todos = o.todos
            .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
            .map((t) => ({
              description: String(t.description ?? "").slice(0, 500),
              expectedFiles: Array.isArray(t.expectedFiles)
                ? t.expectedFiles.map(String).slice(0, 4)
                : [],
            }))
            .filter((t) => t.description && t.expectedFiles.length > 0);
          if (todos.length) out.push({ type: "board_post_todos", todos });
        }
        break;
      case "none":
        out.push({ type: "none" });
        break;
      default:
        break;
    }
  }
  return out.length > 0 ? out : [{ type: "none" }];
}

/** Parse helper model output into a dispatch result. */
export function parseHelperResult(
  raw: string,
  wallMs: number,
): BrainDispatchResult {
  const dispatchId = randomUUID();
  const extracted = extractJsonFromText(raw);
  if (!extracted) {
    return {
      dispatchId,
      status: "blocked",
      summary: "helper produced no JSON result envelope",
      effects: [
        {
          type: "append_system",
          text: `[brain-os] helper output unparseable (${raw.length} chars)`,
        },
      ],
      usage: { wallMs },
    };
  }
  try {
    const obj = JSON.parse(extracted) as Record<string, unknown>;
    return {
      dispatchId,
      status: asStatus(obj.status),
      summary: String(obj.summary ?? "").slice(0, 2000) || "(no summary)",
      effects: asEffects(obj.effects),
      usage: { wallMs },
    };
  } catch {
    return {
      dispatchId,
      status: "blocked",
      summary: "helper JSON parse failed",
      effects: [{ type: "none" }],
      usage: { wallMs },
    };
  }
}
