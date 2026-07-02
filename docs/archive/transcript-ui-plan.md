# Transcript UI Improvement Plan

## Architecture Overview

The transcript rendering is centralized in `web/src/components/transcript/MessageBubble.tsx` (820 LOC) — it dispatches each `TranscriptEntry` to the correct bubble type based on `role` and `summary.kind`. This is the key file for all changes.

**Safety principle:** All changes go through `MessageBubble.tsx` dispatch — new bubble types are additive, existing bubbles are untouched. Preset-specific rendering is gated by `summary.kind`, so blackboard/round-robin/etc. are unaffected.

---

## Part 1: Encompassing Improvements (All Presets)

These improve the transcript experience for ALL presets.

### 1.1 Visual Phase Separation
**What:** Add horizontal dividers between phases (Analysis → Execution → Audit) with phase labels.

**Where:** `MessageBubble.tsx` — detect phase transitions from system messages containing `[Phase 1]`, `[Phase 2]`, `[Phase 3]`, `═══`.

**Implementation:**
- New component: `PhaseDivider.tsx` (~40 LOC)
- Renders a styled horizontal rule with phase name and icon
- Inserted when a system message matches phase transition patterns
- No impact on other presets (they don't have these phase markers)

### 1.2 Agent Avatars with Color Coding
**What:** Each agent gets a colored circle avatar with their index number.

**Where:** `MessageBubble.tsx` — when rendering agent entries, add avatar before the message.

**Implementation:**
- New component: `AgentAvatar.tsx` (~30 LOC)
- Uses existing `agentPalette.ts` HSL hue system
- Renders colored circle with agent index
- Only shown for `role === "agent"` entries
- No impact on other presets (they already have agent colors)

### 1.3 Message Type Indicators
**What:** Add emoji/badge indicators for different message types.

**Where:** `MessageBubble.tsx` — add indicator based on `summary.kind`.

**Implementation:**
- Add indicator mapping in `MessageBubble.tsx`:
  - `council_draft` → 💬
  - `worker_hunks` (success) → ✓
  - `worker_hunks` (skip) → ⏭
  - `audit_review` → 🔍
  - `contradiction` → ⚠️
  - `todo_extracted` → 📋
- Render as small badge next to agent name
- No impact on other presets (different `summary.kind` values)

### 1.4 Progress Bar
**What:** Visual progress indicator showing current phase and completion.

**Where:** `SwarmView.tsx` — add progress bar below the tab bar.

**Implementation:**
- New component: `ProgressBar.tsx` (~60 LOC)
- Reads `phase`, `round`, `totalRounds` from store
- Shows: `Phase 1: ████░░ 67% | Phase 2: ░░░░░░ 0%`
- Only visible during active runs
- No impact on other presets (they can opt-in later)

### 1.5 Transcript Search/Filter
**What:** Filter buttons to show/hide message types.

**Where:** `Transcript.tsx` — add filter bar above transcript.

**Implementation:**
- New component: `TranscriptFilter.tsx` (~50 LOC)
- Filter buttons: [All] [System] [Agents] [Audit] [Issues]
- Filters based on `role` and `summary.kind`
- Client-side filtering (no API changes)
- No impact on other presets (filters are additive)

---

## Part 2: Council-Specific Improvements

These improve the council preset transcript specifically.

### 2.1 Audit Review Cards
**What:** Structured cards for audit reviews instead of raw text.

**Where:** `MessageBubble.tsx` — detect `summary.kind === "council_audit"` and render `AuditReviewCard.tsx`.

**Implementation:**
- New component: `AuditReviewCard.tsx` (~120 LOC)
- Parses audit review text into sections (Progress, Gaps, Issues, Next)
- Renders as a styled card with icons:
  - ✅ Progress section (green)
  - ⚠️ Gaps section (yellow)
  - ❌ Issues section (red)
  - → Next section (blue)
- Collapsible by default (show summary, expand for details)

### 2.2 Execution Status Grid
**What:** Show execution results in a compact grid instead of individual messages.

**Where:** `MessageBubble.tsx` — aggregate execution messages into `ExecutionGrid.tsx`.

**Implementation:**
- New component: `ExecutionGrid.tsx` (~80 LOC)
- Collects consecutive execution messages (`✓ applied`, `skipped`, `✗ failed`)
- Renders as a grid: `Agent 1: ✓ | Agent 2: ⏭ | Agent 3: ✓ | ...`
- Color-coded: green=success, yellow=skipped, red=failed

### 2.3 Council Phase Tabs
**What:** Add sub-tabs within the transcript for each council phase.

**Where:** `SwarmView.tsx` — when preset is "council", show phase tabs.

**Implementation:**
- New component: `CouncilPhaseTabs.tsx` (~50 LOC)
- Tabs: [Discussion] [Execution] [Audit] [All]
- Filters transcript entries by phase
- Only visible when `preset === "council"`

### 2.4 Synthesis Highlight
**What:** Highlight the synthesis entry (final consensus) with special styling.

**Where:** `MessageBubble.tsx` — detect `summary.kind === "council_synthesis"` and render `SynthesisBubble.tsx`.

**Implementation:**
- New component: `SynthesisBubble.tsx` (~60 LOC)
- Special styling: emerald border, "Consensus" badge
- Collapsible (show first 200 chars, expand for full)
- Only for council preset

---

## Implementation Order

1. **Phase 1.1** (Phase Dividers) — Highest impact, simplest
2. **Phase 1.2** (Agent Avatars) — Visual improvement
3. **Phase 2.1** (Audit Review Cards) — Most useful for council
4. **Phase 1.3** (Message Type Indicators) — Quick win
5. **Phase 2.2** (Execution Grid) — Cleans up verbose output
6. **Phase 1.4** (Progress Bar) — Nice to have
7. **Phase 1.5** (Search/Filter) — Power user feature
8. **Phase 2.3** (Phase Tabs) — Advanced organization
9. **Phase 2.4** (Synthesis Highlight) — Polish

---

## File Changes Summary

| New File | LOC | Purpose |
|----------|-----|---------|
| `PhaseDivider.tsx` | ~40 | Phase transition dividers |
| `AgentAvatar.tsx` | ~30 | Colored agent avatars |
| `AuditReviewCard.tsx` | ~120 | Structured audit review cards |
| `ExecutionGrid.tsx` | ~80 | Compact execution status grid |
| `ProgressBar.tsx` | ~60 | Run progress indicator |
| `TranscriptFilter.tsx` | ~50 | Transcript filter buttons |
| `CouncilPhaseTabs.tsx` | ~50 | Council phase sub-tabs |
| `SynthesisBubble.tsx` | ~60 | Highlighted synthesis entry |

| Modified File | Change |
|---------------|--------|
| `MessageBubble.tsx` | Add dispatch for new bubble types |
| `Transcript.tsx` | Add filter bar |
| `SwarmView.tsx` | Add progress bar, council phase tabs |

**Total new code:** ~490 LOC across 8 new files
**Modified files:** 3 existing files (additive changes only)

---

## Safety Measures

1. **Additive only** — New bubble types are added, existing ones untouched
2. **Preset-gated** — Council-specific features only render when `preset === "council"`
3. **No API changes** — All data comes from existing `TranscriptEntry` structure
4. **Fallback safe** — If summary.kind is unknown, render default bubble
5. **Test each preset** — Verify blackboard, round-robin, etc. still work after changes
