# UI coherent-fix package — implementation plan

Three UI bugs that have surfaced repeatedly across 30+ prompts of debugging:

1. **Streaming-collapsibles regression** — pause-based segmentation never fires because OllamaClient delivers in big batches; live streaming bubble shows nothing intermediate
2. **`<think>` tag content not handled** — reasoning model output (`<think>...</think>` markers) leaks raw text + stray closing tags into bubbles
3. **Envelope bubbles ("+N more") have no structured expand** — contract / auditor / debate-verdict envelopes truncate to first 3 items with a literal "…+N more" string; only escape is "VIEW JSON" raw dump

User-facing requirement: "let me see ALL the agent's content (thinking + structured details + streaming progression) in a clean expandable form, like every other modern chat UI does (opencode, ChatGPT, Claude.ai, Cursor)."

---

## Phase 1 — Think-tag extraction (server-side foundation)

**Goal**: detect `<think>...</think>` markers in agent output, split entry into `thoughts` + `finalText`, render thoughts as collapsed-by-default block.

### Files
- NEW: `shared/src/extractThinkTags.ts` — pure helper + tests
- NEW: `shared/src/extractThinkTags.test.ts` — exhaustive edge cases
- EDIT: `web/src/types.ts` — add `thoughts?: string` to `TranscriptEntry`
- EDIT: `server/src/types.ts` — same field on server-side type
- EDIT: `server/src/swarm/blackboard/BlackboardRunner.ts:appendAgent` — call extractThinkTags before constructing entry
- EDIT: every other runner that calls `appendAgent`-equivalent (CouncilRunner, DebateJudgeRunner, etc.) — same call
- NEW: `web/src/components/transcript/ThoughtsBlock.tsx` — collapsed-by-default `<details>`-style block
- EDIT: `web/src/components/transcript/MessageBubble.tsx` — render ThoughtsBlock above the entry's main bubble when `entry.thoughts` is non-empty

### `extractThinkTags` shape

```ts
export function extractThinkTags(text: string): { thoughts: string; finalText: string } {
  if (!text || !text.includes("<think>")) {
    return { thoughts: "", finalText: text };
  }
  const thinkRe = /<think>([\s\S]*?)<\/think>/g;
  const thoughts: string[] = [];
  let stripped = text.replace(thinkRe, (_, content) => {
    thoughts.push(content.trim());
    return "";
  });
  // Handle unclosed <think> (model crashed mid-thought) by treating
  // everything after the last opening tag as a thought.
  const unclosedIdx = stripped.lastIndexOf("<think>");
  if (unclosedIdx !== -1) {
    thoughts.push(stripped.slice(unclosedIdx + 7).trim());
    stripped = stripped.slice(0, unclosedIdx);
  }
  const finalText = stripped.trim();
  return {
    thoughts: thoughts.filter(Boolean).join("\n\n---\n\n"),
    // If everything was a thought (no final text), keep the original
    // so the bubble doesn't render empty. The thoughts block still
    // shows the content, but the main bubble has SOMETHING.
    finalText: finalText.length > 0 ? finalText : text,
  };
}
```

### `ThoughtsBlock` component

```tsx
export function ThoughtsBlock({ text, hue }: { text: string; hue: number }) {
  const [open, setOpen] = useState(false);
  const charCount = text.length;
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="rounded border border-ink-700/60 bg-ink-900/40 text-xs mb-1.5"
    >
      <summary className="cursor-pointer select-none px-2 py-1 text-ink-400 hover:text-ink-200 flex items-center gap-2">
        <span>💭 thinking · {charCount.toLocaleString()} chars</span>
      </summary>
      <div className="px-3 py-2 border-t border-ink-700/60 whitespace-pre-wrap text-ink-300 max-h-[400px] overflow-y-auto">
        {text}
      </div>
    </details>
  );
}
```

### Routing in MessageBubble

```tsx
return (
  <div data-entry-id={entry.id} ...>
    {entry.thoughts && entry.thoughts.length > 0 && (
      <ThoughtsBlock text={entry.thoughts} hue={hue} />
    )}
    {/* existing bubble dispatch */}
    {entry.role === "system" ? <SystemBubble ... /> : ...}
  </div>
);
```

### Tests

- `<think>x</think>after` → thoughts="x", finalText="after"
- `<think>x</think><think>y</think>z` → thoughts="x\n\n---\n\ny", finalText="z"
- `before<think>x</think>after` → thoughts="x", finalText="before\n\nafter" (whitespace-normalized)
- `<think>unclosed` → thoughts="unclosed", finalText="" → preserve original
- `no tags here` → thoughts="", finalText="no tags here"
- empty string → both empty
- nested tags (rare; treat outer as the boundary): `<think>a<think>b</think>c</think>d` → first `</think>` closes; thoughts="a<think>b", finalText="c</think>d" (we accept this because true nesting is not the model's intent)

**Effort**: ~2-3 hours. Low risk — shared/ helper + test + 1 server call site + 1 type extension + 1 small component.

---

## Phase 2 — Content-based streaming segmentation

**Goal**: streaming bubble shows incremental progress with collapsible segments based on CONTENT boundaries (not timing pauses), so it works regardless of chunk-delivery granularity.

### Files
- EDIT: `web/src/components/useSegmentSplitter.ts` — replace `useSegmentSplitterWithPoints` pause logic with content-boundary detection
- EDIT: `server/src/services/AgentManager.ts` — drop `STREAMING_THROTTLE_MS` from 100 → 33 (30 Hz)
- EDIT: `web/src/components/transcript/StreamingDock.tsx` — extend `setSegmentPoints` semantics (no shape change, just feeds the new splitter)

### New segmentation logic

```ts
// In useSegmentSplitterWithPoints
function findContentBoundaries(text: string, prevLen: number): number[] {
  const newBoundaries: number[] = [];
  const appended = text.slice(prevLen);
  if (!appended) return newBoundaries;

  // \n\n boundaries — split after each
  let idx = 0;
  while ((idx = appended.indexOf("\n\n", idx)) !== -1) {
    newBoundaries.push(prevLen + idx + 2);
    idx += 2;
  }

  // code-fence boundaries — split after each ``` (paired)
  let fenceIdx = 0;
  while ((fenceIdx = appended.indexOf("```", fenceIdx)) !== -1) {
    newBoundaries.push(prevLen + fenceIdx + 3);
    fenceIdx += 3;
  }

  // markdown-header boundaries — split BEFORE each \n# / \n## / \n###
  let lineIdx = 0;
  const headerRe = /\n(#{1,4}) /g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(appended)) !== null) {
    newBoundaries.push(prevLen + m.index + 1); // split after the \n
  }

  // Pause-based boundary AS FALLBACK only — keep existing logic
  // but raise the threshold from 5s to 15s. Content boundaries
  // are primary.

  return [...new Set(newBoundaries)].sort((a, b) => a - b);
}
```

### Throttle change

`server/src/services/AgentManager.ts:1473`:
```ts
private static readonly STREAMING_THROTTLE_MS = 33;  // was 100
```

### What this fixes

Pre-fix: with OllamaClient delivering in 1-2 big batches per response, no 5s pauses occur, no segments form, live bubble shows whole-response-at-once.

Post-fix: any `\n\n` paragraph break, code-fence start, or markdown header creates a segment boundary INSTANTLY. A 3000-char response with 6 paragraphs becomes 6 collapsible segments + smooth 30Hz incremental render.

### Tests

If `useSegmentSplitter.test.ts` doesn't exist (web/ has no test runner setup currently), defer tests; do manual visual verification via Playwright video.

**Effort**: ~2 hours. Medium risk — affects every preset's streaming UI.

---

## Phase 3 — Structured envelope expand (ContractBubble + AuditorVerdictBubble)

**Goal**: when an agent emits a known JSON envelope (contract / auditor verdict / debate verdict / worker hunks with many hunks), the bubble offers an expandable structured view, not just "VIEW JSON" raw dump.

### Files
- EDIT: `shared/src/summarizeAgentJson.ts` — add a `parsed: ParsedEnvelope` field to the return value so the client knows the SHAPE not just the summary string
- NEW: `web/src/components/transcript/ContractBubble.tsx` — dedicated component matching `RunFinishedGrid` pattern
- NEW: `web/src/components/transcript/AuditorVerdictBubble.tsx` — same pattern for `{verdicts, newCriteria}` envelopes
- EDIT: `web/src/components/transcript/MessageBubble.tsx` — route to ContractBubble / AuditorVerdictBubble in `AgentClientFallback` when the parsed envelope matches

### `ParsedEnvelope` discriminated union

```ts
// shared/src/summarizeAgentJson.ts
export type ParsedEnvelope =
  | { kind: "contract"; missionStatement: string; criteria: Array<{description: string; expectedFiles: string[]}> }
  | { kind: "auditor"; verdicts: Array<{id: string; status: string; rationale: string; todos?: unknown[]}>; newCriteria?: unknown[] }
  | { kind: "skip"; reason: string }
  | { kind: "todos"; todos: Array<{description: string; expectedFiles: string[]}> }
  | { kind: "unknown" };  // fallback to current AgentJsonBubble

export function summarizeAgentJson(text: string): { summary: string; json: string; parsed: ParsedEnvelope } | null {
  // existing parse + classify logic, but ALSO populate parsed
}
```

### `ContractBubble` shape

```tsx
function ContractBubble({ envelope, header, hue }: { envelope: ContractEnvelope; header: ReactNode; hue: number }) {
  const [view, setView] = useState<"summary" | "full" | "json">("summary");
  const palette = agentBubblePalette(hue, false);

  return (
    <div className={`rounded border-2 ${palette.ring} p-3 my-2`}>
      {header}
      <div className="text-sm font-medium text-ink-200 my-1">
        Contract: {envelope.missionStatement}
      </div>
      <div className="flex gap-2 text-[10px] uppercase tracking-wide my-2">
        <button onClick={() => setView("summary")} className={view === "summary" ? "text-emerald-300 underline" : "text-ink-400"}>Summary</button>
        <button onClick={() => setView("full")} className={view === "full" ? "text-emerald-300 underline" : "text-ink-400"}>All {envelope.criteria.length} criteria</button>
        <button onClick={() => setView("json")} className={view === "json" ? "text-emerald-300 underline" : "text-ink-400"}>JSON</button>
      </div>
      {view === "summary" && (
        <ol className="list-decimal list-inside space-y-1 text-sm text-ink-300">
          {envelope.criteria.slice(0, 3).map((c, i) => (
            <li key={i}>{truncate(c.description, 90)}</li>
          ))}
          {envelope.criteria.length > 3 && (
            <li className="list-none text-ink-500 italic">…+{envelope.criteria.length - 3} more (click "All N criteria" above)</li>
          )}
        </ol>
      )}
      {view === "full" && (
        <ol className="list-decimal list-inside space-y-2 text-sm text-ink-200 max-h-[600px] overflow-y-auto">
          {envelope.criteria.map((c, i) => (
            <li key={i}>
              <div>{c.description}</div>
              {c.expectedFiles?.length > 0 && (
                <div className="text-[11px] font-mono text-ink-500 ml-4">
                  files: {c.expectedFiles.join(", ")}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {view === "json" && (
        <pre className="text-xs font-mono bg-ink-950 p-2 rounded overflow-x-auto max-h-[600px]">
          {JSON.stringify(envelope, null, 2)}
        </pre>
      )}
    </div>
  );
}
```

`AuditorVerdictBubble` follows the same 3-tab pattern (Summary / All N verdicts / JSON).

### Routing in `MessageBubble`

```tsx
// In AgentClientFallback, after tryParseWorkerHunks check:
const parsed = summarizeAgentJson(entry.text);
if (parsed) {
  if (parsed.parsed.kind === "contract") {
    return <ContractBubble envelope={parsed.parsed} header={header} hue={hue} />;
  }
  if (parsed.parsed.kind === "auditor") {
    return <AuditorVerdictBubble envelope={parsed.parsed} header={header} hue={hue} />;
  }
  // existing AgentJsonBubble fallback
  return <AgentJsonBubble ... />;
}
```

### Tests

- New ContractBubble + AuditorVerdictBubble visual check via Playwright video on a real run
- Existing `summarizeAgentJson.test.ts` extended with the new `parsed` field assertions

**Effort**: ~3 hours. Low-medium risk — additive (new components), existing AgentJsonBubble fallback remains for unknown envelope shapes.

---

## Phase 4 — Validation

After all three phases land:

1. Restart dev server (NO_WATCH=1, glm-5.1 default)
2. Fire blackboard run against multi-agent-orchestrator with all 3 monitors + UI watcher
3. Watch the live UI to confirm:
   - Streaming bubble shows incremental segments forming (paragraph + code-fence + header boundaries)
   - `<think>` content renders as collapsed `💭 thinking · N chars` block, no stray `</think>` tags
   - Contract bubble has Summary / All N / JSON tabs; clicking "All N" shows full criteria list
4. Extract Playwright frames at 30s intervals + walk through to confirm each bubble type renders as designed
5. Write fresh post-mortem; update active-work to mark all three issues ✅

---

## Sequencing + dependencies

- **Phase 1 (think-tags)** is independent — can ship first
- **Phase 3 (structured expand)** depends on nothing — can ship in parallel with Phase 1
- **Phase 2 (streaming segments)** depends on neither but is the riskiest (changes throttle behavior + segmentation logic touched by every preset). Ship LAST so a regression there doesn't block validation of #1 + #3

Recommended order: **Phase 1 → Phase 3 → Phase 2 → Phase 4**.

Estimated total: 7-8 hours of focused work + 1 hour validation.

---

## Acceptance criteria (post-Phase 4 validation)

For all three issues, the validation run must show:

- [ ] At least one `<think>...</think>` block detected → renders as `💭 thinking · N chars` collapsed block; expand reveals the thoughts; no raw `</think>` text leakage
- [ ] At least one streaming response with paragraph breaks → live bubble shows incremental segments forming; final entry has `segmentSplitPoints` populated; expanding/collapsing works
- [ ] At least one contract entry with ≥4 criteria → Summary tab shows first 3 + "…+N more"; clicking "All N" tab shows complete list; JSON tab renders raw envelope; tab state persists per-bubble
- [ ] No console errors (Playwright watcher confirms)
- [ ] No regression in WorkerHunksBubble / RunFinishedGrid / DebateVerdictBubble / agents_ready / system entries
