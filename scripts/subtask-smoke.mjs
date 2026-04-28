// #235 spike — minimal smoke test: does opencode v1.14.28 actually
// dispatch a `parts: [{type:"subtask"}]` payload through TaskTool
// when we POST it via session.prompt?
//
// If yes (subtask runs, result comes back inline as <task_result>),
// the SubtaskPartInput foundation is real and the MapReduce migration
// is unblocked. If no (error / silent ignore / parts rejected), we
// know to defer the migration until upstream catches up.
//
// Approach:
//   1. Hit /api/swarm/start with a minimal MapReduce config (just to
//      get one agent spawned with the swarm-orchestrator profile that
//      has `task: "allow"`).
//      Actually — simpler: directly call session.prompt against an
//      already-running agent if any. But we don't have an idle
//      managed agent without starting a swarm first.
//   2. Let me do this differently: just construct a session.prompt
//      payload manually + send it to the opencode binary directly via
//      a child process. That's the cleanest isolated test.
//
// Even simpler: use the SDK directly with a bare opencode subprocess
// (port-managed by us) and just verify the wire-shape doesn't
// reject. We don't need a full LLM round-trip — we just need to know
// opencode accepts parts: [{type:"subtask",...}].

import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

console.log("Smoke test: SubtaskPartInput dispatch via opencode SDK\n");

// Step 1: spawn a fresh opencode server
const PORT = 47000 + Math.floor(Math.random() * 1000);
const winHost = execSync("ip route | awk '/^default/ {print $3}'").toString().trim();
const password = execSync("cmd.exe /c \"echo %OPENCODE_SERVER_PASSWORD%\"")
  .toString()
  .trim()
  .replace(/\r/g, "")
  || "test-only";
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");

console.log(`spawning opencode on port ${PORT}...`);
const proc = spawn(
  "cmd.exe",
  ["/c", `opencode serve --port ${PORT} --hostname 0.0.0.0`],
  {
    env: {
      ...process.env,
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: password,
      OLLAMA_BASE_URL: `http://${winHost}:11434/v1`,
    },
    stdio: "pipe",
  },
);
proc.stdout.on("data", (d) => process.stdout.write(`[opencode] ${d}`));
proc.stderr.on("data", (d) => process.stderr.write(`[opencode-err] ${d}`));

await sleep(8000);  // let opencode warm up

// Helper: HTTP request
async function fetchJson(method, path, body) {
  const url = `http://${winHost}:${PORT}${path}`;
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: r.status, body: json };
}

// Step 2: create a session
console.log("\nstep 2: creating session...");
const sessRes = await fetchJson("POST", "/session", { title: "subtask-smoke" });
console.log("  status:", sessRes.status);
console.log("  body:", JSON.stringify(sessRes.body).slice(0, 200));
const sessionId = sessRes.body?.id || sessRes.body?.info?.id || sessRes.body?.data?.id;
if (!sessionId) {
  console.error("FAIL: couldn't extract session id");
  proc.kill();
  process.exit(1);
}
console.log(`  session: ${sessionId}`);

// Step 3: send a prompt with a subtask part
console.log("\nstep 3: sending prompt with subtask part...");
// Use opencode's built-in `general` agent — our custom agents
// (swarm-orchestrator etc.) are declared in clone-local opencode.json
// and not available in this standalone-spawn smoke setup.
const payload = {
  agent: "general",
  model: { providerID: "ollama", modelID: "glm-5.1:cloud" },
  parts: [
    {
      type: "subtask",
      description: "echo hello",
      prompt: "Reply with the single word: hello",
      agent: "general",
    },
    { type: "text", text: "After the subtask, summarize what it said in one word." },
  ],
};
console.log("  payload parts types:", payload.parts.map((p) => p.type).join(", "));
const promptRes = await fetchJson("POST", `/session/${sessionId}/message`, payload);
console.log("  status:", promptRes.status);
console.log("  body (first 800):", JSON.stringify(promptRes.body).slice(0, 800));

// Step 4: full response inspection — what part types came back?
console.log("\n=== full response analysis ===");
const partsList = promptRes.body?.parts ?? [];
console.log(`  ${partsList.length} parts in response:`);
for (const [i, p] of partsList.entries()) {
  const preview = (p.text ?? p.content ?? "").slice(0, 80);
  console.log(`    [${i}] type=${p.type} ${preview ? `text="${preview}..."` : ""}`);
}
console.log(`  contains <task_result>:`, JSON.stringify(promptRes.body).includes("task_result"));
console.log(`  contains "subtask" part type:`, partsList.some((p) => p.type === "subtask"));

import fs from "node:fs";
fs.writeFileSync(
  "/mnt/c/Users/kevin/Desktop/ollama_swarm/runs_overnight9/subtask-smoke-output.json",
  JSON.stringify(promptRes.body, null, 2),
);
console.log("\n  full response → runs_overnight9/subtask-smoke-output.json");

proc.kill();
