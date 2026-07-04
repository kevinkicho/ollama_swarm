# Brain-OS for External Agents

This guide helps external LLM agents, scripts, or tools use **Brain-as-OS** to get intelligent assistance for swarm configuration, preset selection, run steering, and analysis.

Brain acts as a librarian / master-admin: it understands use-cases from the tables in [`docs/swarm-patterns.md`](swarm-patterns.md) and [`docs/STATUS.md`](STATUS.md), uses historical outcome data, and helps you pick the right preset with explanations.

## Key Communication Channels

- **Conversational help**: `POST /api/swarm/brain/chat`
  - Send natural language goals.
  - Pass `runContext` for live runs (recent transcript summaries, board state, phase).
  - Use `structured: true` (body or `?structured=true`) to get parseable `recommendation` + `config`.
  - Example for "explain options": include "explain all options for my goal" in the message, or use `?explain=options`.

- **Proactive suggestions**: `POST /api/swarm/brain/suggest`
- **History**: `POST /api/swarm/brain/chat-history` (persists per-run)
- **Preset recommendation with data**: `GET /api/swarm/outcome/recommend?directive=...`
  - Returns best preset + rationale + real stats (median/avg scores from past runs).
- **Control**: `/api/swarm/start`, `/api/swarm/amend`, per-run `/status`, `/stop`, etc.
- **Observation**: `/api/swarm/run-summary`, `/memory`, event logs, `/brain/activity`, `/brain/proposals`.

## Use-Case Tables (source of truth for Brain)

See the research workflows table in `swarm-patterns.md` and the full preset matrix in `STATUS.md`. Brain's prompt is built from the shared `server/src/swarm/presetGuide.ts` (no duplication).

Examples:
- Research + write artifacts → hybrid council → blackboard + `webTools: true`
- Broad literature scan → `map-reduce`
- Debate / "should we" → `debate-judge` or `council`
- Exploration → `stigmergy`

The UI Swarm Mode card has matching filters (Research, Analysis/Debate, etc.).

## CLI for Agents

```bash
# Get recommendation (with real numbers when history exists)
ollama-swarm recommend --directive "your goal here" --json

# Full loop
ollama-swarm start --config config.json --json
ollama-swarm status --run-id <id> --json
ollama-swarm amend --run-id <id> --text "focus on X"
ollama-swarm stop --run-id <id>
```

See `bin/ollama-swarm.mjs --help`.

## Example Agent Script

`examples/brain-agent-loop.mjs` demonstrates:
- Calling Brain chat
- Parsing recommendation
- (Dry or real) start via CLI
- Polling status
- Sending amend
- Live context chat

Run: `node examples/brain-agent-loop.mjs "analyze superconductors" [--real-start]`

## Tips for Agents

- **For preset choice**: Describe your *goal/use-case*, not the preset. Brain will quote stats like "council has 0.82 median over 12 runs".
- **Structured responses**: Use `structured:true` to get machine-readable recommendation + config.
- **Live runs**: Build `runContext` from `/status` + summaries and send it with chat messages.
- **Persistence**: Brain chat history is per-run and recovered on review.
- **Limits**: Logs rotate (configurable via `LOG_MAX_BYTES` etc. in config). Use `scripts/prune-logs.mjs`.
- **Research**: Always consider `webTools: true` + `plannerTools: true` for external knowledge.

Brain is designed so external agents can drive complex, multi-step swarm orchestration with good precision and explanations.

## API Surface for Agents

### Core Endpoints
- `POST /api/swarm/brain/chat`
  - Body: `{ messages: [{role: "user", content: "..."}], runContext?: {...}, clonePath?: string, structured?: boolean }`
  - With `structured: true` or `?structured=true`: returns `{ reply, structured: { recommendation, config } }`
  - Pass `runContext` (from `/status` + summaries) for during-run advice.
  - Brain will use preset tables, outcome history, and quote stats like "council has median 8.2/10 over 12 runs".

- `GET /api/swarm/outcome/recommend?directive=...&clonePath=...`
  - Returns `{ preset, rationale, confidence, adaptiveParams }` backed by real run outcomes.

- `GET /api/swarm/status?runId=...`
- `GET /api/swarm/run-summary?clonePath=...&runId=...`
- `POST /api/swarm/amend` , `POST /api/swarm/say` , per-run `/stop`
- `GET /api/swarm/brain/activity` , `/brain/proposals` , `/brain/health`

- Event logs for replay: `/api/v2/event-log/runs/:runId`

### Structured Recommendation Example
Request with structured:
```json
{ "messages": [{ "role": "user", "content": "I need to scan many papers and synthesize findings without writing code" }], "structured": true }
```

Response includes:
```json
{
  "structured": {
    "recommendation": { "preset": "map-reduce", "confidence": 0.85, "rationale": "..." },
    "config": { "preset": "map-reduce", "webTools": true, ... }
  }
}
```

## Best Practices for External Agents

- **Describe goals, not presets**: "Help me do a broad literature review on X and produce a findings doc" → Brain picks map-reduce or hybrid + webTools.
- **Use history**: Pass `clonePath` to get real median/avg scores from past runs.
- **Iterate with context**: After start, fetch status/summary, build runContext, continue chatting.
- **Steer safely**: Use `/amend` for mid-run changes; `/brain/suggest` for proactive transcript injections.
- **Parse robustly**: Prefer `structured` responses. Fall back to fenced JSON or balanced object extraction (see shared/src/extractJson.ts).
- **Prune & compress**: Rotated logs are .gz; run `node scripts/prune-logs.mjs --apply` and `prune-runs.mjs`.
- **Limits**: Configure `LOG_MAX_BYTES`, `DEBUG_MAX_BYTES` etc. via env or config.

## Full Example Flow (Pseudocode)

```js
const goal = "...";

// 1. Get recommendation (structured for easy parsing)
let reply = await chat({ 
  messages: [{role:'user', content: goal}], 
  structured: true 
});
let rec = reply.structured?.recommendation;
let config = reply.structured?.config || rec;   // config may be under recommendation or top level

console.log(`Brain picked ${rec?.preset} because: ${rec?.rationale}`);

// 2. Start the run
const start = await fetch('/api/swarm/start', {
  method:'POST', 
  body: JSON.stringify(config)
});
const runId = start.runId;

// 3. Monitor + steer loop
while (true) {
  const status = await fetch(`/api/swarm/status?runId=${runId}`).then(r => r.json());
  if (['completed','stopped','failed'].includes(status.phase)) break;

  const context = {
    runId,
    phase: status.phase,
    // build from /run-summary or transcript events
    recentTranscript: status.transcript?.slice(-5) || [],
    boardCounts: status.boardCounts
  };

  reply = await chat({ 
    messages: [{role:'user', content: "How is progress? Any suggestions?"}], 
    runContext: context, 
    structured: true 
  });

  if (reply.structured?.recommendation) {
    // Brain may suggest an amend
    const amendText = extractAmendFromReply(reply);
    if (amendText) await fetch('/api/swarm/amend', { 
      method:'POST', body: JSON.stringify({runId, text: amendText}) 
    });
  }
  await sleep(15000);
}
```

See `examples/brain-agent-loop.mjs` for a working version of this pattern (with polling + amend).
```

## Concrete Structured Response Example

When you send `structured: true`:

**Input (excerpt):**
```json
{
  "messages": [{"role": "user", "content": "I want to broadly scan many papers and synthesize common patterns"}],
  "structured": true
}
```

**Output (excerpt):**
```json
{
  "reply": "Based on your goal... RECOMMENDATION: {...} CONFIG: {...}",
  "structured": {
    "recommendation": {
      "preset": "map-reduce",
      "confidence": 0.82,
      "rationale": "Broad scan of sources matches map-reduce strengths..."
    },
    "config": {
      "preset": "map-reduce",
      "webTools": true,
      "agentCount": 5,
      ...
    }
  }
}
```

## Related Files

- `server/src/swarm/presetGuide.ts` (shared tables + builders)
- `server/src/swarm/outcomeHistory.ts` (recommender + stats)
- `examples/brain-agent-loop.mjs` (runnable demo)
- `bin/ollama-swarm.mjs` (CLI with --json, recommend, amend, status)
- `docs/swarm-patterns.md` and `STATUS.md` (source tables)
- `web/src/components/BrainStartChat.tsx` (UI equivalent)

This setup lets Brain-OS agents provide precise, data-backed assistance and execution control.

See also the main README, AGENT-GUIDE.md, and ARCHITECTURE-VISION.md for more context.

## UI Features for "Explain Options"

In the Brain chat UI (BrainStartChat):

- When you type a message containing "explain options", "show all options", "compare presets", etc., the UI automatically surfaces a compact table of all presets with strengths and bestFor tags (after the response).
- There's a dedicated **"📋 Structured ON/OFF"** toggle button next to Send. When ON (default for setup), the chat requests structured responses so the UI can cleanly show:
  - Recommendation with confidence %
  - Rationale
  - Auto-apply the config

This makes it easy for humans too: ask "explain all options for literature review" and get the table + recommendation.

## Advanced: Always Getting Tables

Even without keywords, you can force it by:
- Using structured mode
- Asking the LLM "list all presets in a table for this goal"

The backend will include the table data in the reply when it detects option-explaining intent.

## More Examples

**Example 1: Research use-case**
User: "I need to do broad analysis across many documents and produce a synthesis report"
→ Brain recommends map-reduce or council, with table if asked, and config with webTools.

**Example 2: During-run**
With runContext, Brain can say "Given current board has 4 open todos, I suggest amending to focus on X" and you can apply directly.

**Example 3: Agent script using toggle equivalent**
```js
const res = await fetch(..., { body: JSON.stringify({ messages, structured: true }) });
const { structured } = await res.json();
if (structured?.recommendation) { /* use it */ }
```

## Future / Related

- The UI table rendering can be enhanced to clickable chips that prefilter the Swarm Mode card.
- CLI and examples already support --json and structured.
- See `shared/src/presetGuide.ts` for the canonical data (no duplication).

This setup gives external agents (and humans via UI) rich, table-backed explanations for preset choice.