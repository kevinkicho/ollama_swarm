# Plan 5: Dedicated Planning Tab — Separate Planning Decisions from Work Items

## Problem

The Board tab conflates two different concerns:
1. **Work items** (Kanban) — Open/Claimed/Committed/Stale/Skipped todos
2. **Planning decisions** — Planner streaming text, contract criteria, auditor verdicts, tier promotions

This makes both views harder to use. The Kanban is cluttered with planning overhead
(PlannerThinkingPanel, FindingsPane), and planning events are buried in the transcript
instead of being prominently displayed.

## Solution: Dedicated Planning Tab

Create a new "Planning" tab that surfaces all planning-related events in a structured,
chronological view. Move planning-specific UI out of the Board tab.

## What Moves from Board → Planning

- `PlannerThinkingPanel` (planner streaming text, criteria count, mission statement)
- `FindingsPane` (agent findings about work quality)

## What Stays on Board

- 5-column Kanban (Open/Claimed/Committed/Stale/Skipped)
- SummaryCard (run stats when completed)
- Cost breakdown (in SummaryCard)

## New Planning Tab Layout

```
┌─────────────────────────────────────────────────────┐
│  PLANNING TAB                                        │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─ Current Contract ─────────────────────────────┐ │
│  │ Mission: "Add government panels, consolidate..."│ │
│  │ Tier: 3/∞  |  Criteria: 8 met, 2 unmet        │ │
│  │                                                 │ │
│  │ ✓ c1: Audit server routes...                    │ │
│  │ ✓ c2: Create FaoPanel...                        │ │
│  │ ⏳ c3: Consolidate tabs...                      │ │
│  │ ✗ c4: Add durability (retry logic)...           │ │
│  └─────────────────────────────────────────────────┘ │
│                                                     │
│  ┌─ Planner Activity ─────────────────────────────┐ │
│  │ ✦ Planner is thinking (14s, 1,269 chars)       │ │
│  │ [streaming tail — last 600 chars]              │ │
│  │ Mission: "Extend dashboard with 15 panels..."  │ │
│  │ Writing criterion #5 of 8...                   │ │
│  └─────────────────────────────────────────────────┘ │
│                                                     │
│  ┌─ Audit History ────────────────────────────────┐ │
│  │ Audit #12: 3 status changes, 2 new todos       │ │
│  │   c1 met — "File exists, FRED series present"  │ │
│  │   c3 unmet — "Panel not rendered in App.jsx"   │ │
│  │   c5 unmet → 2 todos posted                    │ │
│  │ Audit #11: 0 status changes                    │ │
│  └─────────────────────────────────────────────────┘ │
│                                                     │
│  ┌─ Tier History ─────────────────────────────────┐ │
│  │ Tier 1 → 2: "Added Fao, ILO, WHO, UN panels"  │ │
│  │ Tier 2 → 3: "Added 8 panels across tabs..."    │ │
│  │ Tier 3 → current: "Add 15 panels + durability" │ │
│  └─────────────────────────────────────────────────┘ │
│                                                     │
│  ┌─ Findings ─────────────────────────────────────┐ │
│  │ Agent 3: "docs/PANELS.md missing UNHCR entry"  │ │
│  │ Agent 2: "src/App.jsx has duplicate import"     │ │
│  └─────────────────────────────────────────────────┘ │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Data Sources (All Already in Store)

### Current Contract
- `useSwarm(s => s.contract)` — ExitContract with missionStatement + criteria
- Each criterion has `status: "met" | "wont-do" | "unmet"` and `rationale`

### Planner Activity (Streaming)
- `useSwarm(s => s.streaming)` — planner's cumulative streaming text
- `useSwarm(s => s.streamingMeta)` — startedAt, lastTextAt, status
- `useSwarm(s => s.agents)` — planner agent status (thinking/ready)

### Audit History
- Extract from `transcript` entries where `role === "system"` and text matches
  audit patterns ("Auditor applied:", "criterion met", "criterion unmet")
- OR add structured audit events to the store (cleaner approach)

### Tier History
- Extract from `transcript` entries matching "Contract (tier N):" and
  "Ambition ratchet: all tier N criteria resolved"

### Findings
- `useSwarm(s => s.findings)` — existing findings array

## Components to Create

### 1. `PlanningTab.tsx` (new — replaces BoardView's planning sections)

Main container for the Planning tab. Renders sub-sections:

```tsx
export function PlanningTab() {
  return (
    <div className="h-full overflow-y-auto space-y-3 p-3">
      <CurrentContractPanel />
      <PlannerActivitySection />
      <AuditHistorySection />
      <TierHistorySection />
      <FindingsSection />
    </div>
  );
}
```

### 2. `CurrentContractPanel.tsx` (new)

Renders the current contract with criteria status:

```tsx
function CurrentContractPanel() {
  const contract = useSwarm(s => s.contract);
  if (!contract) return <EmptyState message="No contract yet" />;

  const met = contract.criteria.filter(c => c.status === "met").length;
  const unmet = contract.criteria.filter(c => c.status === "unmet").length;
  const wontDo = contract.criteria.filter(c => c.status === "wont-do").length;

  return (
    <Panel title="Current Contract" accent="emerald">
      <div className="text-xs text-ink-400 mb-2">
        Mission: {contract.missionStatement}
      </div>
      <div className="flex gap-3 text-[11px] mb-3">
        <span className="text-emerald-400">✓ {met} met</span>
        <span className="text-amber-400">⏳ {unmet} unmet</span>
        <span className="text-ink-500">— {wontDo} wont-do</span>
      </div>
      <div className="space-y-1">
        {contract.criteria.map(c => (
          <CriterionRow key={c.id} criterion={c} />
        ))}
      </div>
    </Panel>
  );
}
```

### 3. `AuditHistorySection.tsx` (new)

Extracts audit events from transcript and renders them chronologically:

```tsx
function AuditHistorySection() {
  const transcript = useSwarm(s => s.transcript);
  const audits = useMemo(() => extractAuditEvents(transcript), [transcript]);

  return (
    <Panel title="Audit History" accent="sky">
      {audits.length === 0 ? (
        <EmptyState message="No audits yet" />
      ) : (
        <div className="space-y-2">
          {audits.map((audit, i) => (
            <AuditEntry key={i} audit={audit} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function extractAuditEvents(transcript: TranscriptEntry[]) {
  // Find system entries matching audit patterns
  return transcript
    .filter(e => e.role === "system" && /auditor applied|criterion/i.test(e.text))
    .map(e => ({
      ts: e.ts,
      text: e.text,
      // Parse status changes from the text
    }));
}
```

### 4. `TierHistorySection.tsx` (new)

Extracts tier promotions from transcript:

```tsx
function TierHistorySection() {
  const transcript = useSwarm(s => s.transcript);
  const tiers = useMemo(() => extractTierEvents(transcript), [transcript]);

  return (
    <Panel title="Tier History" accent="violet">
      {tiers.map((tier, i) => (
        <TierEntry key={i} tier={tier} />
      ))}
    </Panel>
  );
}

function extractTierEvents(transcript: TranscriptEntry[]) {
  return transcript
    .filter(e => e.role === "system" && /Contract \(tier \d+\)/i.test(e.text))
    .map(e => ({
      ts: e.ts,
      text: e.text,
      tier: parseInt(e.text.match(/tier (\d+)/)?.[1] ?? "0"),
    }));
}
```

### 5. `FindingsSection.tsx` (moved from BoardView)

Same as existing FindingsPane, just relocated.

## Changes to Existing Files

### `SwarmView.tsx`
- Add `"planning"` to the tab type union
- Add Planning tab button and content area
- Remove PlannerThinkingPanel from BoardView

### `BoardView.tsx`
- Remove `<PlannerThinkingPanel />` (moved to PlanningTab)
- Remove `<FindingsPane />` (moved to PlanningTab)
- Board becomes pure Kanban + SummaryCard

### `App.tsx` (no changes needed — tabs are in SwarmView)

## Store Changes

### Add audit history to store (optional but cleaner)

Instead of parsing transcript text, add structured audit events:

```typescript
// In store.ts
interface AuditEvent {
  ts: number;
  invocation: number;
  statusChanges: Array<{ criterionId: string; from: string; to: string; rationale: string }>;
  newTodos: number;
  newCriteria: number;
}
```

Wire into `auditorRunner.ts` where `applyAuditorResult` fires — emit an
`audit_completed` event that the store captures.

This is cleaner than regex-parsing transcript text, but requires server-side
changes (emitting the event). The transcript-parsing approach works immediately
without server changes.

## Visual Design Principles

1. **Contract is primary** — top of the Planning tab, always visible
2. **Chronological flow** — audit history and tier history are timeline-style
3. **Collapsible sections** — each section can be collapsed to save space
4. **Color coding** — emerald for contract, sky for audit, violet for tiers
5. **Streaming integration** — planner activity uses the same PlannerThinkingPanel
   component, just relocated from Board to Planning

## Files to Create

1. `web/src/components/PlanningTab.tsx` — Main Planning tab container
2. `web/src/components/planning/CurrentContractPanel.tsx` — Contract display
3. `web/src/components/planning/AuditHistorySection.tsx` — Audit timeline
4. `web/src/components/planning/TierHistorySection.tsx` — Tier history
5. `web/src/components/planning/FindingsSection.tsx` — Findings (moved)

## Files to Modify

1. `web/src/components/SwarmView.tsx` — Add "planning" tab type + routing
2. `web/src/components/BoardView.tsx` — Remove PlannerThinkingPanel + FindingsPane

## Edge Cases

- **No contract yet** (planning phase, before contract is generated): Show "Planning in progress..." with streaming panel
- **No audit history yet** (first tier, no audits fired): Show "No audits yet"
- **No tier history** (tier 1, no promotions): Show "Tier 1 — initial contract"
- **Run completed**: Contract panel shows final state, audit/tier history is complete
- **Run in progress**: Sections update in real-time as new events arrive

## UX Benefits

1. **Clear mental model** — "Board = what's being worked on" vs "Planning = how decisions were made"
2. **Contract as first-class** — Users see the contract immediately, not buried in SummaryCard
3. **Audit trail** — Visible history of what the auditor decided and why
4. **Tier progression** — Clear view of how the run evolved across tiers
5. **Planner streaming** — Stays prominent but in context with the contract it's generating
