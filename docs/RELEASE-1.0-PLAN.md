# ollama_swarm Release Plan — Trusted Appliance 1.0

**Status:** In progress (Phase 0–2 landing)  
**Date:** 2026-07-09  
**Goal:** Ship a **trusted local multi-agent coding OS** with a secure host boundary, crash-safe races, honest preset maturity, and Brain as operator (not auto-patcher).

---

## Product freeze (Phase 0)

### Core (GA — default story)

| Preset | Role |
|--------|------|
| `blackboard` | Primary write OS |
| `council` | Discussion + execution write path |
| `baseline` | Eval floor / single-agent |
| `pipeline` | Composite (experimental tests; UI: supported) |

### Supported

`round-robin`, `orchestrator-worker`

### Experimental (selectable, labeled)

`role-diff`, `map-reduce`, `debate-judge`, `moa`, `pipeline`

### Research / needs-validation

`stigmergy` (read-only), `orchestrator-worker-deep`

### Non-goals for 1.0

- Multi-tenant SaaS / unauthenticated LAN exposure as default
- Auto platform self-patch (Brain stays recording / librarian)
- Reintroducing cloud admission or full stream-guard retry loops
- Claiming all 12 presets production-equal

---

## Phases

| Phase | Focus | Exit criteria |
|-------|--------|----------------|
| **0** | Product freeze + this plan | ✅ Maturity badges in UI + STATUS |
| **1** | Host security | ✅ Default bind `127.0.0.1`; optional API token; MCP gated; workspace roots; SSRF; static path jail; bash spawn |
| **2** | Never-crash-on-race | ✅ TodoQueue late-complete safe; BB crash abort-first; per-run stop debounce |
| **3** | Long-run quality | ✅ Council: 429/quota never counts as audit-stuck; finite rounds stop as provider-quota |
| **4** | Architecture SoT | ✅ Partial: status `phase` prefers V2 for terminal/pause; `runStateV2` on status |
| **5** | Platform CI | ✅ GitHub Actions matrix ubuntu + windows; eval score unit tests in CI |
| **6** | Eval honesty | ✅ scoreRun: no chatty free points; conformance when present; stopReason nuance |
| **7** | Brain 1.0 | ✅ Approve-to-provision default (`SWARM_BRAIN_AUTO_PROVISION=false`) |

**Versioning:** `0.2.0` ≈ Phase 0–2 · `0.3.0` ≈ Phase 0–7 foundation · `1.0.0` after live Core eval + Windows green history.

### Remaining polish (post Phase 7)

- Full V2 phase drives mid-flight UI (retire dual flags)
- Live Core scoreboard regeneration (not only unit scorer)
- Wire `apiFetch` across all web `fetch("/api/...")` call sites
- Brain UI “Approve & start” button for provisioner

---

## Phase 1 env knobs

| Variable | Default | Meaning |
|----------|---------|---------|
| `SERVER_HOST` | `127.0.0.1` | Listen address (`0.0.0.0` to expose LAN — requires token) |
| `SWARM_API_TOKEN` | unset | If set, require `Authorization: Bearer …` or `X-Swarm-Token` on `/api/*` (except health/version) |
| `SWARM_ALLOW_MCP_SERVERS` | `false` | Allow start-body / env MCP process spawn |
| `SWARM_WORKSPACE_ROOTS` | empty | Comma-separated absolute roots; when set, clone/parent paths must fall under one |

---

## Success metrics

- Stop: no transcript after “ports released” (live smoke)
- Crash: abort sessions before long snapshot window
- Security: unauth start rejected when token set; MCP denied when flag off
- Concurrent: stop A does not hard-kill B via shared debounce
- Docs: STATUS + known-limitations aligned

---

## Related

- Architecture vision: `docs/ARCHITECTURE-VISION.md`
- Stop contract: `docs/run-stop-drain-lifecycle.md`
- Decisions: `docs/decisions.md`
- Known limitations: `docs/known-limitations.md`
