# P7: System Wrapper UI — Brain Layer Interface

## Problem

The current UI is run-centric — you're either in a run (SwarmView) or at the setup form.
There's no persistent system-level view to monitor the brain, manage runs, or see system health.

## Goal

Create a wrapper UI that provides:
1. **System status** — brain health, Ollama status, provider keys
2. **Run management** — list active/queued/past runs, quick-switch
3. **Brain interface** — proposals, health, activity timeline
4. **Persistent navigation** — always visible, not tied to a specific run

## UI Sketch

```
┌─────────────────────────────────────────────────────────────────────┐
│  HEADER                                                             │
│  ┌─────────────────┐  ┌──────────────────────────────────────────┐  │
│  │ 🧠 ollama_swarm │  │ System Health: ✓ Ollama ● Model: deep..│  │
│  │    v2.0         │  │ Brain: 3 proposals │ Runs: 2 active    │  │
│  └─────────────────┘  └──────────────────────────────────────────┘  │
├──────────┬──────────────────────────────────────────────────────────┤
│ SIDEBAR  │  MAIN CONTENT                                            │
│ 240px    │                                                          │
│          │  ┌─────────────────────────────────────────────────────┐ │
│ ┌──────┐ │  │ RUN QUEUE                                           │ │
│ │System│ │  │ ┌─────────┬──────────┬─────────┬────────┬────────┐ │ │
│ │Status│ │  │ │ Run ID  │ Status   │ Phase   │ Started│ Actions│ │ │
│ └──────┘ │  │ ├─────────┼──────────┼─────────┼────────┼────────┤ │ │
│          │ │  │ 2634a11d│ ● active │ exec    │ 2m ago │ View   │ │ │
│ ┌──────┐ │  │ 5561323a│ ○ idle   │ done    │ 1h ago │ Review │ │ │
│ │Brain │ │  │ 87b7ae50│ ○ queued │ —       │ —      │ Start  │ │ │
│ │      │ │  └─────────┴──────────┴─────────┴────────┴────────┘ │ │
│ │ 3    │ │                                                       │ │
│ │ prop.│ │  ┌─────────────────────────────────────────────────────┐ │
│ │      │ │  │ BRAIN PROPOSALS                                    │ │
│ │ [▶]  │ │  │ ┌───────────────────────────────────────────────┐  │ │
│ └──────┘ │  │ │ 🧠 Auto-anchor for worker file visibility     │  │ │
│          │ │  │    Priority: HIGH • Component: workerRunner.ts │  │ │
│ ┌──────┐ │  │ │    [Apply] [Reject] [Details]                 │  │ │
│ │Quick │ │  │ └───────────────────────────────────────────────┘  │ │
│ │Nav   │ │  │ ┌───────────────────────────────────────────────┐  │ │
│ │      │ │  │ │ 🧠 Pre-check files before TODOs              │  │ │
│ │▸Runs │ │  │ │    Priority: MED • Component: planner.ts      │  │ │
│ │▸Brain│ │  │ │    [Apply] [Reject] [Details]                 │  │ │
│ │▸Sys  │ │  │ └───────────────────────────────────────────────┘  │ │
│ └──────┘ │  └─────────────────────────────────────────────────────┘ │
│          │                                                          │
│          │  ┌─────────────────────────────────────────────────────┐ │
│          │  │ SYSTEM METRICS                                     │ │
│          │  │ ┌─────────────┬─────────────┬─────────────────────┐│ │
│          │  │ │ Total Runs  │ Success Rate│ Avg Duration        ││ │
│          │  │ │ 47          │ 72%         │ 12m 34s             ││ │
│          │  │ └─────────────┴─────────────┴─────────────────────┘│ │
│          │  └─────────────────────────────────────────────────────┘ │
│          │                                                          │
│          │  ┌─────────────────────────────────────────────────────┐ │
│          │  │ RECENT ACTIVITY                                    │ │
│          │  │ • Run 2634a11d completed (12 commits)              │ │
│          │  │ • Brain proposal: auto-anchor (high priority)      │ │
│          │  │ • Run 5561323a started (blackboard, 4 agents)      │ │
│          │  └─────────────────────────────────────────────────────┘ │
└──────────┴──────────────────────────────────────────────────────────┘
```

## When User Clicks "View" on a Run

The main content area switches to SwarmView for that specific run:

```
┌──────────┬──────────────────────────────────────────────────────────┐
│ SIDEBAR  │  SwarmView (run 2634a11d)                               │
│          │  [← Back to System]                                      │
│ ┌──────┐ │  ┌─────────────────────────────────────────────────────┐ │
│ │System│ │  │ (existing SwarmView content)                        │ │
│ │Status│ │  │ Transcript | Metrics | Board | Planning | ...       │ │
│ └──────┘ │  └─────────────────────────────────────────────────────┘ │
│          │                                                          │
│ ┌──────┐ │                                                          │
│ │Brain │ │                                                          │
│ └──────┘ │                                                          │
│          │                                                          │
│ ┌──────┐ │                                                          │
│ │Quick │ │                                                          │
│ │Nav   │ │                                                          │
│ │▸Runs │ │                                                          │
│ │▸Brain│ │                                                          │
│ │▸Sys  │ │                                                          │
│ └──────┘ │                                                          │
└──────────┴──────────────────────────────────────────────────────────┘
```

## Implementation Plan

### P7.1: System Status Component (2-3 hr)
- [ ] Create `SystemStatusPanel.tsx` — shows Ollama health, model, provider keys
- [ ] Add to header (replaces current SystemHealthDashboard)

### P7.2: Run Queue Component (3-4 hr)
- [ ] Create `RunQueuePanel.tsx` — shows active/queued/past runs
- [ ] Add View/Stop/Start actions
- [ ] Show run lifecycle status

### P7.3: Brain Panel Enhancement (2-3 hr)
- [ ] Enhance `BrainProposalsPanel.tsx` — wire Apply/Reject buttons
- [ ] Add brain health indicator
- [ ] Add proposal history

### P7.4: Quick Navigation (2-3 hr)
- [ ] Create `QuickNavPanel.tsx` — sidebar navigation
- [ ] Add run switching
- [ ] Add system status links

### P7.5: Layout Restructure (4-6 hr)
- [ ] Create `SystemWrapper.tsx` — wraps entire app
- [ ] Persistent sidebar with system/brain/nav
- [ ] Main content area for run-specific views
- [ ] Header shows system status

### P7.6: Cross-Run Metrics (2-3 hr)
- [ ] Add total tokens/cost across runs
- [ ] Add average duration
- [ ] Add success rate trends

### P7.7: Patch Monitor (3-4 hr)
- [ ] `PatchMonitorPanel.tsx` — shows patch lifecycle
- [ ] Patch status: pending → preparing → applying → applied/failed
- [ ] Patch preview: show diff before applying
- [ ] Patch history: timeline of applied patches
- [ ] Patch health: did patch cause issues? rollback status
- [ ] Rollback button for failed patches

### P7.8: Brain Activity Timeline (2-3 hr)
- [ ] `BrainActivityPanel.tsx` — shows brain's actions over time
- [ ] Timeline: analyzed → proposed → patched → verified
- [ ] Brain health: model latency, success rate, error count
- [ ] Proposal acceptance rate
- [ ] System improvement score over time

## Total Estimated Effort: 20-25 hr

## Priority

| Component | Priority | Effort |
|-----------|----------|--------|
| P7.1 System Status | High | 2-3 hr |
| P7.2 Run Queue | High | 3-4 hr |
| P7.3 Brain Panel | Medium | 2-3 hr |
| P7.4 Quick Nav | Medium | 2-3 hr |
| P7.5 Layout | High | 4-6 hr |
| P7.6 Metrics | Low | 2-3 hr |
| P7.7 Patch Monitor | High | 3-4 hr |
| P7.8 Brain Activity | Medium | 2-3 hr |

## Detailed Patch Monitor Design

### What to Show

| Section | Data | Why |
|---------|------|-----|
| **Patch Queue** | Patches waiting to be applied | User sees what's coming |
| **Active Patch** | Currently applying patch | Progress indicator |
| **Patch History** | Applied/rejected patches | Audit trail |
| **Patch Preview** | Diff before applying | User approval |
| **Patch Health** | Rollback status, error count | Safety monitoring |
| **Brain Activity** | Analysis → Proposal → Patch flow | Transparency |

### Patch Status Flow

```
┌─────────────────────────────────────────────────────┐
│ PATCH LIFECYCLE                                      │
│                                                      │
│  Brain Analysis → Proposal Generated → Patch Ready   │
│       ↓              ↓                  ↓            │
│  [Analyzing]    [Proposed]         [Ready to Apply]  │
│                                      ↓               │
│                              User Approves?          │
│                              ↓           ↓           │
│                           [Yes]        [No]          │
│                             ↓           ↓            │
│                        [Applying]   [Rejected]       │
│                             ↓                       │
│                    ┌────────┴────────┐              │
│                    ↓                 ↓              │
│               [Applied]         [Failed]            │
│                    ↓                 ↓              │
│               [Verified]      [Rollback?]           │
│                                 ↓       ↓           │
│                            [Yes]     [No]           │
│                               ↓       ↓             │
│                          [Rolled]  [Broken]         │
└─────────────────────────────────────────────────────┘
```

### Patch Preview Component

```
┌─────────────────────────────────────────────────────┐
│ PATCH PREVIEW                                        │
│                                                      │
│ 🧠 Auto-anchor for worker file visibility            │
│ Priority: HIGH                                       │
│                                                      │
│ File: workerRunner.ts                                │
│ ─────────────────────────────────────────────────── │
│ - import { autoDetectAnchors } from "./autoAnchor"; │
│ + import { autoDetectAnchors } from "./autoAnchor.js"│
│                                                      │
│ File: autoAnchor.ts                                  │
│ ─────────────────────────────────────────────────── │
│ + export function extractSectionKeywords(...) { ... }│
│                                                      │
│ [Apply] [Reject] [Details]                           │
└─────────────────────────────────────────────────────┘
```

### Brain Activity Timeline

```
┌─────────────────────────────────────────────────────┐
│ BRAIN ACTIVITY                                       │
│                                                      │
│ ● 10:32 AM — Analyzed run 2634a11d                  │
│   12 exceptions, 8 interaction chains                │
│   Found 3 new patterns                              │
│                                                      │
│ ● 10:33 AM — Generated proposal                     │
│   "Auto-anchor for worker file visibility"           │
│   Priority: HIGH                                     │
│                                                      │
│ ○ 10:34 AM — Waiting for user approval               │
│                                                      │
│ ● 10:35 AM — Applied patch to workerRunner.ts        │
│   Git commit: abc123                                 │
│   Verified: ✓                                        │
│                                                      │
│ ● 10:36 AM — System health check                     │
│   All patches applied successfully                   │
│   System improvement score: +2.3%                    │
└─────────────────────────────────────────────────────┘
```
