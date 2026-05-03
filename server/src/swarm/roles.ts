// Unit 8: role differentiation. The seven roles from docs/swarm-patterns.md §1.
// Same model for every agent, different priors — each role's `guidance` is
// prepended to the normal round-robin prompt so the agent has a distinct lens
// before reading the shared transcript.

export interface SwarmRole {
  name: string;
  guidance: string;
  // 2026-05-02 (role-diff improvement #3): per-role concrete-deliverable
  // hint shown to the role at turn time. Tells THIS role what its
  // `### MY DELIVERABLE` block must contain — e.g. Implementer must list
  // file changes; Tester must list assertions. Empty string = generic
  // "concrete contribution to the directive". Optional so existing
  // role catalogs (DEFAULT_ROLES) work unchanged.
  deliverableHint?: string;
}

export const DEFAULT_ROLES: readonly SwarmRole[] = [
  {
    name: "Architect",
    guidance:
      "Think in modules, data flow, and long-term evolution. Push back on sprawl, duplicated state, and abstractions that will calcify. Name the actual architectural choice you'd make and why.",
  },
  {
    name: "Tester",
    guidance:
      "Think about what could break. Name the edge cases, missing coverage, flaky surfaces, and hard-to-reproduce conditions. When you propose a test, say what it asserts, not just 'add a test'.",
  },
  {
    name: "Security reviewer",
    guidance:
      "Look for injection, auth gaps, exposed secrets, supply-chain risk, and unsafe defaults. Cite the specific line or dependency. If you see nothing to flag, say so — don't invent threats.",
  },
  {
    name: "Performance critic",
    guidance:
      "Look for hot paths, N+1 patterns, unnecessary allocations, blocking I/O on request paths, and cache misses. Give a rough order-of-magnitude on what it costs and where you'd measure first.",
  },
  {
    name: "Docs reader",
    guidance:
      "Read as a new contributor arriving cold. What's confusing, missing, or contradicted by the code? Does the README explain what this project is and isn't? Is CONTRIBUTING runnable end-to-end?",
  },
  {
    name: "Dependency auditor",
    guidance:
      "Inspect package.json and lockfiles. Pinned vs floating, bloat, abandoned packages, duplicated transitive graphs. Flag anything shipping non-standard minified code or installing post-install scripts.",
  },
  {
    name: "Devil's advocate",
    guidance:
      "Challenge the emerging consensus. Ask whether the proposed next action is the *right* next action or just the most visible one. If the swarm agrees too quickly, that's your signal to push back.",
  },
] as const;

// Agent indices start at 1 (see AgentManager). Cycle with modulo so any
// agentCount > roles.length wraps back to role 0 — agent 8 becomes Architect
// again, which is fine for v1: the preset's cap is 8 and the catalog has 7.
export function roleForAgent(agentIndex: number, roles: readonly SwarmRole[]): SwarmRole {
  if (!Number.isInteger(agentIndex) || agentIndex < 1) {
    throw new Error(`roleForAgent: agentIndex must be an integer >= 1 (got ${agentIndex})`);
  }
  if (roles.length === 0) {
    throw new Error("roleForAgent: roles array is empty");
  }
  return roles[(agentIndex - 1) % roles.length];
}

// 2026-05-02 (role-diff improvement #2): task-shaped role catalog. Used
// when a user directive is set — every role contributes ONE piece of
// the work the directive asks for, instead of producing a separate
// audit lens. Same 7-slot shape as DEFAULT_ROLES so the modulo wrap
// behavior is unchanged for agent counts up to 8.
export const BUILD_ROLES: readonly SwarmRole[] = [
  {
    name: "Researcher",
    guidance:
      "Find prior art and existing context. What does this repo already do that's relevant to the directive? What patterns/libraries already exist? Use grep/find aggressively. Cite real file paths.",
    deliverableHint:
      "List 3-5 concrete findings — `path/to/file.ts:42 — does X` — that anchor the rest of the team's work in real code.",
  },
  {
    name: "Designer",
    guidance:
      "Propose the SHAPE of the solution. What's the API? What's the data model? What's the call flow? Trade off alternatives explicitly. Don't write code; specify the contract.",
    deliverableHint:
      "A concrete shape: function signatures / interface bodies / data schema / sequence of calls. Bullets, not prose.",
  },
  {
    name: "Implementer",
    guidance:
      "Translate the design into a step-by-step file-edit plan. Which files? What changes? What order? Be specific enough that another engineer could execute it without asking questions.",
    deliverableHint:
      "Numbered list of file edits: `1. src/foo.ts — add bar() that … 2. src/foo.test.ts — assert …`. No fluff.",
  },
  {
    name: "Tester",
    guidance:
      "Specify what verifies the directive is actually met. Name the assertions. Name the edge cases. Name the regression risks the implementer might miss.",
    deliverableHint:
      "List of test cases — `it(\"<assertion>\")` lines or equivalent. Group by happy-path / edge / regression.",
  },
  {
    name: "Reviewer",
    guidance:
      "Find the gaps in what the team has produced. Where would a senior reviewer push back? What's underspecified? What invariant is at risk? Don't be polite — be useful.",
    deliverableHint:
      "Numbered list of concrete review findings — each with WHERE (which agent's claim or which file) and WHY (the specific risk).",
  },
  {
    name: "Documenter",
    guidance:
      "Specify what docs need to ship alongside this change so a new contributor can use it. README updates, ADR notes, code comments where the WHY is non-obvious. Don't over-document.",
    deliverableHint:
      "Bullets: `<file>:<heading> — add/change <one-line description>`. Skip if no doc changes are warranted; say so.",
  },
  {
    name: "Devil's advocate",
    guidance:
      "Challenge the path the team is converging on. Is the directive itself the right framing? Is there a smaller / simpler / different solution that would work? Push back on what's been glossed.",
    deliverableHint:
      "1-3 specific counter-claims. For each: what the team is assuming, why it might be wrong, and what to do instead.",
  },
] as const;

// 2026-05-02 (role-diff improvement #2): catalog selector. When a user
// directive is set, the team should be solving the directive (BUILD
// roles); when no directive, it's a general repo audit (DEFAULT_ROLES).
// User-supplied custom roles always win — they're an explicit override.
export function selectRoleCatalog(input: {
  customRoles?: readonly SwarmRole[];
  userDirective?: string;
}): readonly SwarmRole[] {
  if (input.customRoles && input.customRoles.length > 0) return input.customRoles;
  const hasDirective = (input.userDirective ?? "").trim().length > 0;
  return hasDirective ? BUILD_ROLES : DEFAULT_ROLES;
}
