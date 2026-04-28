// #235 smoke 2 — characterize SubtaskPartInput response shape:
//   1. spawn opencode in a real clone dir (so our opencode.json with
//      swarm-orchestrator/swarm-read/swarm-builder loads)
//   2. send parent=swarm-orchestrator + 2 subtasks (different agent
//      = swarm-read) — different agents avoid the same-agent collapse
//      we saw in smoke 1.
//   3. inspect BOTH session.prompt's immediate response AND the full
//      session.messages list — opencode may create child messages
//      (linked by parentID) for each subtask, not parts on the parent.

import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";

const PORT = 47000 + Math.floor(Math.random() * 1000);
const winHost = execSync("ip route | awk '/^default/ {print $3}'").toString().trim();
const password = (execSync("cmd.exe /c \"echo %OPENCODE_SERVER_PASSWORD%\"").toString().trim().replace(/\r/g, "")) || "test-only";
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");

// Real clone dir — has our opencode.json with swarm-orchestrator etc.
const CLONE_DIR = "C:\\Users\\kevin\\Desktop\\ollama_swarm\\runs_overnight9\\multi-agent-orchestrator";

console.log(`smoke2: spawning opencode in cwd=${CLONE_DIR.slice(-50)}...\n`);
const proc = spawn(
  "cmd.exe",
  ["/c", `cd /d ${CLONE_DIR} && opencode serve --port ${PORT} --hostname 0.0.0.0`],
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

await sleep(8000);

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

// 1. session.create
console.log("\nstep 1: create session...");
const sessRes = await fetchJson("POST", "/session", { title: "subtask-smoke2" });
console.log("  status:", sessRes.status);
const sessionId = sessRes.body?.id || sessRes.body?.info?.id || sessRes.body?.data?.id;
if (!sessionId) {
  console.error("FAIL: couldn't get session id"); proc.kill(); process.exit(1);
}
console.log(`  session: ${sessionId}`);

// 2. send prompt with parent=swarm-orchestrator + 2 subtasks (child=swarm-read)
console.log("\nstep 2: prompt with 2 subtasks (child=swarm-read)...");
const payload = {
  agent: "swarm-orchestrator",
  model: { providerID: "ollama", modelID: "glm-5.1:cloud" },
  parts: [
    {
      type: "subtask",
      description: "list dir A",
      prompt: "Run a single tool call: list the top-level entries in src/. Reply with ONLY a JSON array of file names. No prose.",
      agent: "swarm-read",
    },
    {
      type: "subtask",
      description: "list dir B",
      prompt: "Run a single tool call: list the top-level entries in scripts/. Reply with ONLY a JSON array of file names. No prose.",
      agent: "swarm-read",
    },
    {
      type: "text",
      text: "Above are two subtasks. After both complete, respond with: SUMMARY: I saw <N> entries in src/ and <M> in scripts/.",
    },
  ],
};
const t0 = Date.now();
const promptRes = await fetchJson("POST", `/session/${sessionId}/message`, payload);
const elapsed = Date.now() - t0;
console.log(`  status: ${promptRes.status}, elapsed: ${elapsed}ms`);

// 3. inspect IMMEDIATE response shape
console.log("\n=== prompt response analysis ===");
const partsList = promptRes.body?.parts ?? [];
console.log(`  parent message info: id=${promptRes.body?.info?.id?.slice(0,12)}, agent=${promptRes.body?.info?.agent}`);
console.log(`  ${partsList.length} parts:`);
for (const [i, p] of partsList.entries()) {
  const preview = (p.text ?? p.content ?? p.input?.prompt ?? "").slice(0, 60);
  console.log(`    [${i}] type=${p.type}${p.tool ? ` tool=${p.tool}` : ""} ${preview ? `"${preview}..."` : ""}`);
}

// 4. fetch ALL messages on the session — subtasks may be separate messages
console.log("\nstep 4: GET /session/{id}/messages (all messages incl. children)...");
const msgsRes = await fetchJson("GET", `/session/${sessionId}/message`);
console.log(`  status: ${msgsRes.status}`);
const messages = Array.isArray(msgsRes.body) ? msgsRes.body : (msgsRes.body?.messages ?? []);
console.log(`  ${messages.length} messages on this session:`);
for (const [i, m] of messages.entries()) {
  const info = m.info ?? m;
  const parts = m.parts ?? [];
  console.log(`    [${i}] role=${info.role} agent=${info.agent ?? "-"} parentID=${info.parentID?.slice(0,12) ?? "-"} parts=${parts.length}`);
  for (const [j, p] of parts.entries()) {
    const preview = (p.text ?? p.content ?? "").slice(0, 50).replace(/\n/g, " ");
    console.log(`        part[${j}] type=${p.type}${p.tool ? ` tool=${p.tool}` : ""} ${preview ? `"${preview}..."` : ""}`);
  }
}

// 5. save full data
const outDir = "/mnt/c/Users/kevin/Desktop/ollama_swarm/runs_overnight9";
fs.writeFileSync(`${outDir}/subtask-smoke2-prompt.json`, JSON.stringify(promptRes.body, null, 2));
fs.writeFileSync(`${outDir}/subtask-smoke2-messages.json`, JSON.stringify(messages, null, 2));
console.log(`\n  saved → ${outDir}/subtask-smoke2-{prompt,messages}.json`);

proc.kill();
console.log("\n✓ smoke2 complete");
