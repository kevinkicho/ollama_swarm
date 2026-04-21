import { z } from "zod";

// ---------------------------------------------------------------------------
// Worker response schema. Shape: {"diffs": [{"file": string, "newText": string}]}
// Intentionally blunt — full-file replacement. Patch-based diffs are a v2 concern
// (the plan calls this out explicitly). A 200KB cap per file keeps a runaway
// model from buying us half a gigabyte of prose.
// ---------------------------------------------------------------------------

const DiffSchema = z.object({
  file: z.string().trim().min(1).max(1000),
  newText: z.string().max(200_000),
});

const WorkerResponseSchema = z.object({
  diffs: z.array(DiffSchema).max(2),
  skip: z.string().trim().min(1).max(500).optional(),
});

export interface WorkerDiff {
  file: string;
  newText: string;
}

export type WorkerParseResult =
  | { ok: true; diffs: WorkerDiff[]; skip?: string }
  | { ok: false; reason: string };

// Same extraction pattern as planner.ts: try strict JSON.parse first so a
// perfectly-shaped top-level object isn't chewed into something else by the
// fallback heuristics. Only if that fails do we try fence-stripping.
function stripFences(raw: string): string | null {
  const s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  const innerFence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (innerFence) return innerFence[1].trim();
  // Prose-then-object: slice between first '{' and last '}'. Only meaningful
  // if there's prose before the opening brace; otherwise it'd just re-return s.
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) {
    return s.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

export function parseWorkerResponse(
  raw: string,
  expectedFiles: string[],
): WorkerParseResult {
  let parsed: unknown;
  let lastError = "";
  try {
    parsed = JSON.parse(raw.trim());
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    const cleaned = stripFences(raw);
    if (cleaned === null) {
      return { ok: false, reason: `JSON parse failed: ${lastError}` };
    }
    try {
      parsed = JSON.parse(cleaned);
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      return { ok: false, reason: `JSON parse failed: ${msg}` };
    }
  }

  const v = WorkerResponseSchema.safeParse(parsed);
  if (!v.success) {
    const reason = v.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, reason };
  }

  // Workers must stay inside the TODO's expectedFiles. Anything else is a bug
  // or a prompt-injection attempt, and either way the runner shouldn't have
  // to decide what to do with it.
  const allowed = new Set(expectedFiles);
  const seen = new Set<string>();
  for (const d of v.data.diffs) {
    if (!allowed.has(d.file)) {
      return { ok: false, reason: `diff file "${d.file}" not in expectedFiles` };
    }
    if (seen.has(d.file)) {
      return { ok: false, reason: `duplicate diff for "${d.file}"` };
    }
    seen.add(d.file);
  }

  return { ok: true, diffs: v.data.diffs.map((d) => ({ file: d.file, newText: d.newText })), skip: v.data.skip };
}

// ---------------------------------------------------------------------------
// Prompts.
// ---------------------------------------------------------------------------

export const WORKER_SYSTEM_PROMPT = [
  "You are a WORKER agent in a swarm. You are implementing a single TODO from the shared board.",
  "",
  "HARD RULES:",
  "1. Output ONLY a JSON object. No prose. No markdown fences. No commentary before or after.",
  "2. Shape: {\"diffs\": [{\"file\": string, \"newText\": string}]}",
  "3. `file` MUST be one of the paths in the TODO's expectedFiles list. Do not touch any other file.",
  "4. `newText` is the ENTIRE new contents of the file. You are replacing the whole file — include every line you want to keep.",
  "5. If a listed file doesn't need changes, omit it from `diffs`. Do not echo unchanged files.",
  "6. If the TODO is impossible, unsafe, or already done, respond with: {\"diffs\": [], \"skip\": \"brief reason\"}",
  "7. Maximum 2 diffs per response.",
  "",
  "You will be given the TODO description, the expected file paths, and the current contents of each file (or a note that it does not exist).",
].join("\n");

export interface WorkerSeed {
  todoId: string;
  description: string;
  expectedFiles: string[];
  // null = file does not exist on disk (worker is creating it).
  fileContents: Record<string, string | null>;
}

export function buildWorkerUserPrompt(seed: WorkerSeed): string {
  const parts: string[] = [
    `TODO: ${seed.description}`,
    `Expected files: ${seed.expectedFiles.join(", ")}`,
    "",
  ];
  for (const f of seed.expectedFiles) {
    const content = seed.fileContents[f];
    if (content === null || content === undefined) {
      parts.push(`=== ${f} (does not exist — you would be creating it) ===`);
    } else {
      parts.push(`=== Current contents of ${f} ===`);
      parts.push(content);
      parts.push(`=== end ${f} ===`);
    }
    parts.push("");
  }
  parts.push("Output your JSON now. Remember: full-file replacement in `newText`, JSON only.");
  return parts.join("\n");
}

export function buildWorkerRepairPrompt(previousResponse: string, parseError: string): string {
  return [
    "Your previous response could not be parsed as the required JSON object.",
    `Parser error: ${parseError}`,
    "",
    "Your previous response was:",
    "--- BEGIN PREVIOUS RESPONSE ---",
    previousResponse,
    "--- END PREVIOUS RESPONSE ---",
    "",
    "Respond now with ONLY a JSON object matching:",
    '{"diffs": [{"file": "path", "newText": "full contents"}]}',
    "",
    "No prose. No markdown fences. No commentary. Just the JSON object.",
  ].join("\n");
}
