import fs from "fs";
import path from "path";

const srcPath = "server/src/swarm/runConfigTypes.ts";
const src = fs.readFileSync(srcPath, "utf8").replace(/^\uFEFF/, "");
const ifaceRe = /export\s+interface\s+RunConfig\s*\{/;
const m = ifaceRe.exec(src);
if (!m) {
  console.error("RunConfig interface not found in", srcPath);
  process.exit(1);
}
const open = m.index + m[0].length - 1; // position of '{'
let depth = 0;
let end = -1;
for (let i = open; i < src.length; i++) {
  const c = src[i];
  if (c === "{") depth++;
  else if (c === "}") {
    depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
}
if (end < 0) {
  console.error("could not find end of RunConfig interface");
  process.exit(1);
}
const body = src.slice(open + 1, end);
console.log("interface body length", body.length);

// Split into field chunks: leading comments + property ending at top-level `;`
const fields = [];
let i = 0;
const n = body.length;

function skipString(from) {
  const q = body[from];
  let j = from + 1;
  while (j < n) {
    if (body[j] === "\\") {
      j += 2;
      continue;
    }
    if (body[j] === q) return j + 1;
    j++;
  }
  return n;
}

function skipLineComment(from) {
  let j = from + 2;
  while (j < n && body[j] !== "\n") j++;
  return j;
}

function skipBlockComment(from) {
  let j = from + 2;
  while (j < n - 1) {
    if (body[j] === "*" && body[j + 1] === "/") return j + 2;
    j++;
  }
  return n;
}

while (i < n) {
  // Skip pure whitespace at start of a member region is fine to include in chunk
  const start = i;
  // Find start of a property name at indent 2 (possibly after comments)
  let propStart = -1;
  let j = i;
  let brace = 0;
  let paren = 0;
  let bracket = 0;

  // First scan: advance through comments/whitespace until we hit a field or end
  while (j < n) {
    // whitespace
    if (body[j] === " " || body[j] === "\t" || body[j] === "\r" || body[j] === "\n") {
      j++;
      continue;
    }
    // line comment
    if (body[j] === "/" && body[j + 1] === "/") {
      j = skipLineComment(j);
      continue;
    }
    // block comment
    if (body[j] === "/" && body[j + 1] === "*") {
      j = skipBlockComment(j);
      continue;
    }
    // potential field at this position — must be at line start with 2-space indent
    // look back to line start
    let lineStart = j;
    while (lineStart > 0 && body[lineStart - 1] !== "\n") lineStart--;
    const linePrefix = body.slice(lineStart, j);
    if (/^ {2}$/.test(linePrefix) && /[a-zA-Z_]/.test(body[j])) {
      propStart = j;
      break;
    }
    // unexpected token
    console.warn("unexpected token at", j, JSON.stringify(body.slice(j, j + 40)));
    j++;
  }
  if (propStart < 0) {
    // trailing comments only
    if (body.slice(start).trim()) {
      // ignore trailing whitespace/comments without field
    }
    break;
  }

  // Scan from propStart to end of field (top-level semicolon)
  j = propStart;
  brace = paren = bracket = 0;
  let fieldEnd = -1;
  while (j < n) {
    const c = body[j];
    if (c === "/" && body[j + 1] === "/") {
      j = skipLineComment(j);
      continue;
    }
    if (c === "/" && body[j + 1] === "*") {
      j = skipBlockComment(j);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      j = skipString(j);
      continue;
    }
    if (c === "{") brace++;
    else if (c === "}") brace = Math.max(0, brace - 1);
    else if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (c === "[") bracket++;
    else if (c === "]") bracket = Math.max(0, bracket - 1);
    else if (c === ";" && brace === 0 && paren === 0 && bracket === 0) {
      fieldEnd = j + 1;
      break;
    }
    j++;
  }
  if (fieldEnd < 0) {
    console.error("unterminated field near", JSON.stringify(body.slice(propStart, propStart + 60)));
    process.exit(1);
  }
  const chunk = body.slice(start, fieldEnd).replace(/^\r?\n+/, "").replace(/\s+$/, "");
  fields.push(chunk);
  i = fieldEnd;
}

function fieldName(chunk) {
  // name is first `  name?:` at line start, not in comment
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    const mm = line.match(/^  ([a-zA-Z_][\w]*)\??\s*:/);
    if (mm) return mm[1];
  }
  return null;
}

const CORE = new Set([
  "repoUrl",
  "localPath",
  "agentCount",
  "rounds",
  "model",
  "preset",
  "userDirective",
  "roles",
  "proposition",
  "useLocal",
  "createdBy",
  "reqId",
  "runId",
  "topology",
  "brainInitiated",
  "brainProposalId",
  "suppressSeedMessages",
  "pipeline",
]);
const MODELS = new Set([
  "plannerModel",
  "workerModel",
  "auditorModel",
  "brainModel",
  "orchestratorModel",
  "midLeadModel",
  "moaProposerModel",
  "moaAggregatorModel",
  "moaProposerModels",
  "writeModel",
  "plannerFallbackModel",
  "dispositionModels",
  "dynamicModelRoute",
]);
const CAPS = new Set([
  "wallClockCapMs",
  "tokenBudget",
  "maxCostUsd",
  "planningWallClockCapMs",
  "ambitionTiers",
  "continuous",
  "adaptiveWorkers",
]);
const THINK = new Set([
  "thinkGuardRefereeEnabled",
  "thinkGuardRefereeModel",
  "thinkGuardRefereeMaxCallsPerRun",
  "thinkGuardRefereeMinThinkChars",
  "thinkGuardRefereeThinkTailMinChars",
  "thinkGuardRefereeThinkTailMaxChars",
  "thinkGuardRefereeMaxOutputTokens",
  "thinkGuardRefereeCallsUsed",
]);
const BLACKBOARD = new Set([
  "councilContract",
  "councilSharedExplore",
  "critic",
  "uiUrl",
  "verifyCommand",
  "auditorOnlyMutations",
  "requireAuditorVerification",
  "plannerTools",
  "webTools",
  "projectGraphContext",
  "mcpServers",
  "enableBrainAnalysis",
  "autoGenerateGoals",
  "planningFastPath",
  "skipContractDerivation",
  "autoStretchReflection",
  "autoRollback",
  "verifier",
  "workerDispositions",
  "autoMemory",
  "autoDesignMemory",
  "resumeContract",
  "resumeExecutionFromRunId",
  "dedicatedAuditor",
  "specializedWorkers",
  "criticEnsemble",
  "selfConsistencyK",
  "debateAudit",
  "debateAuditRounds",
  "parallelHypothesis",
  "parallelHypothesisInFlight",
  "testDrivenTodos",
  "preflightDryRun",
  "hunkRag",
  "stigmergyOnBlackboard",
  "pheromoneHotseed",
  "pheromoneHotFiles",
  "useWorkerPipeline",
  "failurePatternSeed",
  "providerFailover",
]);

const groups = {
  core: [],
  models: [],
  caps: [],
  thinkGuard: [],
  blackboard: [],
  discussion: [],
};

const names = [];
for (const f of fields) {
  const name = fieldName(f);
  names.push(name);
  if (!name) {
    console.warn("unnamed chunk", f.slice(0, 60));
    continue;
  }
  if (CORE.has(name)) groups.core.push(f);
  else if (MODELS.has(name)) groups.models.push(f);
  else if (CAPS.has(name)) groups.caps.push(f);
  else if (THINK.has(name)) groups.thinkGuard.push(f);
  else if (BLACKBOARD.has(name)) groups.blackboard.push(f);
  else groups.discussion.push(f);
}

console.log(
  "fields",
  fields.length,
  "group sizes",
  Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
);
const missing = names.filter(Boolean).filter(
  (n) =>
    !CORE.has(n) &&
    !MODELS.has(n) &&
    !CAPS.has(n) &&
    !THINK.has(n) &&
    !BLACKBOARD.has(n),
);
console.log("discussion/extra:", missing.join(", "));

function fixImports(chunk) {
  return chunk
    .replace(
      /import\("\.\/pipelinePhases\.js"\)/g,
      'import("../pipelinePhases.js")',
    )
    .replace(
      /import\("\.\.\/\.\.\/\.\.\/shared\//g,
      'import("../../../../shared/',
    );
}

const outDir = "server/src/swarm/runConfig";
fs.mkdirSync(outDir, { recursive: true });

function writePartial(name, ifaceName, chunks, extraImports = "") {
  const fixed = chunks.map(fixImports);
  const content =
    `// Partial RunConfig fields — ${ifaceName}\n` +
    extraImports +
    `export interface ${ifaceName} {\n` +
    fixed.map((c) => (c.startsWith("  ") ? c : "  " + c)).join("\n") +
    `\n}\n`;
  fs.writeFileSync(path.join(outDir, name), content);
}

writePartial(
  "core.ts",
  "RunConfigCore",
  groups.core,
  `import type { SwarmRole } from "../roles.js";\nimport type { PresetId } from "../SwarmRunner.js";\n\n`,
);
writePartial("models.ts", "RunConfigModels", groups.models);
writePartial("caps.ts", "RunConfigCaps", groups.caps);
writePartial("thinkGuard.ts", "RunConfigThinkGuard", groups.thinkGuard);
writePartial("blackboard.ts", "RunConfigBlackboard", groups.blackboard);
writePartial("discussion.ts", "RunConfigDiscussion", groups.discussion);

const index = `// Composed RunConfig from partial interfaces (mechanical extract from runConfigTypes.ts).
import type { RunConfigCore } from "./core.js";
import type { RunConfigModels } from "./models.js";
import type { RunConfigCaps } from "./caps.js";
import type { RunConfigThinkGuard } from "./thinkGuard.js";
import type { RunConfigBlackboard } from "./blackboard.js";
import type { RunConfigDiscussion } from "./discussion.js";

export type { RunConfigCore } from "./core.js";
export type { RunConfigModels } from "./models.js";
export type { RunConfigCaps } from "./caps.js";
export type { RunConfigThinkGuard } from "./thinkGuard.js";
export type { RunConfigBlackboard } from "./blackboard.js";
export type { RunConfigDiscussion } from "./discussion.js";

/** Full per-run config — intersection of focused partial interfaces. */
export type RunConfig = RunConfigCore &
  RunConfigModels &
  RunConfigCaps &
  RunConfigThinkGuard &
  RunConfigBlackboard &
  RunConfigDiscussion;
`;
fs.writeFileSync(path.join(outDir, "index.ts"), index);

const shim = `// Re-export shim — partial interfaces live in ./runConfig/
export type { RunConfig } from "./runConfig/index.js";
export type {
  RunConfigCore,
  RunConfigModels,
  RunConfigCaps,
  RunConfigThinkGuard,
  RunConfigBlackboard,
  RunConfigDiscussion,
} from "./runConfig/index.js";
`;
fs.writeFileSync(srcPath, shim);
console.log("done");
