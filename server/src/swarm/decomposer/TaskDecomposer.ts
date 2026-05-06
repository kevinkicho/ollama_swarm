// Direction 4 Phase 1: task decomposer agent.
//
// Given a user directive (or GitHub issue), the decomposer produces a
// structured decomposition into sub-tasks. Each sub-task specifies its
// own preset, agent count, rounds, and dependencies. The result drives
// the DAG executor (Phase 2) which runs sub-tasks in parallel where
// possible.
//
// The decomposer is itself a single LLM call — no swarm needed.

import type { PresetId } from "../SwarmRunner.js";
import type { Agent } from "../../services/AgentManager.js";
import { chatOnce } from "../chatOnce.js";
import { extractText } from "../extractText.js";

export interface SubTask {
  id: string;
  title: string;
  description: string;
  preset: PresetId;
  agentCount: number;
  rounds: number;
  model?: string;
  dependencies: string[];
  files: string[];
  priority: number;
}

export interface Decomposition {
  subTasks: SubTask[];
  criticalPathLength: number;
  estimatedRounds: number;
}

const VALID_PRESETS: PresetId[] = [
  "round-robin", "blackboard", "role-diff", "council",
  "orchestrator-worker", "orchestrator-worker-deep", "debate-judge",
  "map-reduce", "stigmergy", "baseline", "moa", "pipeline",
];

const DECOMPOSER_PROMPT = `You are a TASK DECOMPOSER for a multi-agent swarm system.

Given a user's directive, decompose it into independent sub-tasks that can be executed by specialized swarm presets. Each sub-task should map to the BEST preset for its type.

Available presets:
- round-robin (3 agents): collaborative discussion, brainstorming, seeking diverse opinions
- council (3 agents): design decisions, architecture, expert deliberation
- debate-judge (3 agents): evaluating pros/cons, safety analysis, contested decisions
- map-reduce (4 agents): comprehensive auditing, finding all instances of something
- orchestrator-worker (3 agents): implementation, code changes, building features
- orchestrator-worker-deep (4 agents): complex refactors, multi-file migrations
- blackboard (4 agents): autonomous code changes with planner/worker/auditor
- stigmergy (3 agents): exploration, codebase understanding, file discovery
- moa (4 agents): synthesizing multiple perspectives, blending approaches
- role-diff (3 agents): comparing approaches, contrast analysis
- baseline (1 agent): simple, straightforward tasks
- pipeline (3 agents): multi-step workflows requiring different presets per step

Output STRICT JSON only — no fences, no prose:
{
  "subTasks": [
    {
      "id": "task-1",
      "title": "short title",
      "description": "what this sub-task should accomplish (1-3 sentences)",
      "preset": "map-reduce",
      "agentCount": 4,
      "rounds": 3,
      "dependencies": [],
      "files": ["src/auth.ts"],
      "priority": 0
    }
  ],
  "criticalPathLength": 2,
  "estimatedRounds": 6
}

Rules:
- Each sub-task gets its own preset + params
- dependencies lists ONLY other sub-task IDs that MUST complete first
- The dependency graph MUST be a DAG (no cycles)
- priority is 0 = highest, increment for lower priority
- agentCount: 1-8 (respect the preset's sweet spot)
- rounds: 1-10
- If the task is simple enough for one preset, return exactly 1 sub-task
- For complex tasks, decompose into 2-5 sub-tasks that can run in parallel where possible`;

export function buildDecomposerPrompt(directive: string, repoContext?: string): string {
  let prompt = DECOMPOSER_PROMPT;
  prompt += `\n\nUser directive:\n${directive.trim()}`;
  if (repoContext && repoContext.length > 0) {
    prompt += `\n\nRepository context:\n${repoContext.trim().slice(0, 3000)}`;
  }
  return prompt;
}

export function parseDecomposition(raw: string): Decomposition | null {
  const text = raw.trim();
  if (!text) return null;

  const candidates: string[] = [text];
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/m.exec(text);
  if (fence) candidates.push(fence[1]!.trim());
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Record<string, unknown>;
      if (!parsed.subTasks || !Array.isArray(parsed.subTasks)) continue;

      const subTasks: SubTask[] = [];
      for (const raw of parsed.subTasks as Record<string, unknown>[]) {
        if (typeof raw.id !== "string" || typeof raw.title !== "string" || typeof raw.preset !== "string") continue;
        if (!VALID_PRESETS.includes(raw.preset as PresetId)) continue;
        subTasks.push({
          id: raw.id,
          title: raw.title,
          description: typeof raw.description === "string" ? raw.description : "",
          preset: raw.preset as PresetId,
          agentCount: typeof raw.agentCount === "number" ? Math.max(1, Math.min(8, raw.agentCount)) : 3,
          rounds: typeof raw.rounds === "number" ? Math.max(1, Math.min(10, raw.rounds)) : 3,
          model: typeof raw.model === "string" ? raw.model : undefined,
          dependencies: Array.isArray(raw.dependencies)
            ? raw.dependencies.filter((d): d is string => typeof d === "string")
            : [],
          files: Array.isArray(raw.files)
            ? raw.files.filter((f): f is string => typeof f === "string")
            : [],
          priority: typeof raw.priority === "number" ? Math.max(0, raw.priority) : 0,
        });
      }

      if (subTasks.length === 0) continue;
      if (!isDAG(subTasks)) continue;

      return {
        subTasks,
        criticalPathLength: typeof parsed.criticalPathLength === "number" ? parsed.criticalPathLength : 1,
        estimatedRounds: typeof parsed.estimatedRounds === "number" ? parsed.estimatedRounds : subTasks.length * 3,
      };
    } catch {
      // try next
    }
  }
  return null;
}

function isDAG(tasks: SubTask[]): boolean {
  const ids = new Set(tasks.map((t) => t.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string): boolean {
    if (visited.has(id)) return true;
    if (visiting.has(id)) return false;
    if (!ids.has(id)) return true;

    visiting.add(id);
    const task = tasks.find((t) => t.id === id);
    if (task) {
      for (const dep of task.dependencies) {
        if (!visit(dep)) return false;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  }

  for (const task of tasks) {
    if (!visit(task.id)) return false;
  }
  return true;
}

export async function decomposeTask(
  agent: Agent,
  directive: string,
  repoContext?: string,
  log?: (msg: string) => void,
): Promise<Decomposition | null> {
  const prompt = buildDecomposerPrompt(directive, repoContext);
  let responseText: string;
  try {
    const res = await chatOnce(agent, {
      agentName: "swarm-decomposer",
      promptText: prompt,
    });
    responseText = extractText(res) ?? "";
  } catch (err) {
    log?.(`Task decomposition failed (${err instanceof Error ? err.message : String(err)}).`);
    return null;
  }

  if (!responseText) {
    log?.("Task decomposition: model returned empty.");
    return null;
  }

  const decomposition = parseDecomposition(responseText);
  if (!decomposition) {
    log?.("Task decomposition: response did not parse as a valid decomposition.");
    return null;
  }

  log?.(`Task decomposition: ${decomposition.subTasks.length} sub-task(s), critical path ${decomposition.criticalPathLength}`);
  return decomposition;
}