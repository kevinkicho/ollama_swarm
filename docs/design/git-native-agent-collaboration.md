# Git-native multi-agent collaboration

| Field | Value |
|-------|-------|
| **Date** | 2026-07-18 |
| **Status** | In progress (first slice shipping) |
| **Supersedes** | Hunk-JSON as the primary inter-agent work product |
| **Related** | `brain-os-agentic-dispatch.md`, `workingTreeCommit.ts`, ToolDispatcher |

---

## Problem

Agents historically collaborated by **throwing search/replace hunks and diffs at each other** (worker → auditor propose, judge votes on hunk shapes). That is brittle:

- Invented anchors miss; apply no-ops; repair thrash.
- Concurrent workers cannot share a real working tree.
- Discussion presets (RR, MoA, OW) reasoned in prose then bolted on a one-shot hunk apply.

The durable substrate is already **git** (clone, commit, status, diff). Collaboration should use **disk + git**, not invented patch dialects.

## Design principles

1. **Working tree is source of truth.** Prefer `write` / `edit` / host `run` (npm, git) then `{workingTree:true,files,message}`.
2. **Hunks are optional small-patch sugar**, not the collaboration bus.
3. **Maximal tool freedom** within clone sandbox (`resolveSafe`). Profile denials are **contestable**, not silent leashes.
4. **Peer/master review** for contested tools and for commits (auditor/hierarchy deliberation) — same resilience control plane.
5. **OpenCode SDK is not the runtime** (removed E3 2026-04-29). Contests route through **ToolDispatcher + deliberation + WS**, not opencode permission UI. If OpenCode UI returns later, map the same contest events into it.

## Mode wiring

| Mode | Collaboration path |
|------|-------------------|
| **Blackboard** | Workers get write/edit/git tools; finish workingTree or small hunks; auditor reviews git status/diff then commits |
| **Council** | Same worker path (`councilWorkerAttempt` already supports workingTree commit) |
| **OR / OW-Deep / RR / MoA** | Discussion remains conversational; wrap-up apply prefers workingTree when executeNextAction |
| **Baseline** | Prefer write tools + workingTree envelope over pure hunk emit |

## Tool freedom + contest

```
dispatch(tool):
  if unsafe path escape → hard deny (never contestable)
  if profile deny:
    emit contestable denial + deliberation claim
    if agent contests (next turn / contestTool envelope) → queue for peer/master
    peer/master approve → one-shot allow; deny → permanent for that call shape
  else allow
```

**Not removed:** path sandbox, bash wall-clock, MCP opt-in flag.  
**Softened:** expectedFiles hard fence (already soft), worker read-only profile, permanent bash lockout as only thrash brake.

## Guards / phase-gates relevance

| Gate | Keep? | Why |
|------|-------|-----|
| `resolveSafe` / clone scope | **Yes** | Security OS physics |
| Productive progress / zero-progress | **Yes** | Durability of autonomy |
| Structural hunk validate | **Yes** (hunk path only) | Prevents autoApprove shipping syntax garbage |
| Emit-only profile for JSON repair | **Yes** | Prevents tool-loop thrash on repair turns |
| Unix-bash rewrite on Windows | **Yes** | Host honesty |
| expectedFiles hard reject | **No** (soft) | Already soft-fence |
| Worker read-only while inventing hunks | **No** | Blocks git-native work |
| Seed-direct skip explore | **Keep optional** | Cost control; Brain OS recovers |

## Implementation slices

1. **Worker profiles → write/git tools**; design doc (this). ✅
2. Contestable ToolDispatcher denials + deliberation claim. ✅
3. Prompt alignment (wrap-up, baseline, discussion builders). ✅ (baseline single-attempt + wrap-up tool chat + workingTree commit)
4. UI: contest list on resilience panel; workingTree in worker bubbles. ✅
5. Optional: reintroduce OpenCode permission bridge if product requires that UI.

---

## Non-goals

- Force every discussion preset to mutate the repo every turn.
- Administrator / UAC elevation.
- Full OpenCode SDK reinstall in this slice.
