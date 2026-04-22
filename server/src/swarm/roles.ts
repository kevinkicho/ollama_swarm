// Unit 8: role differentiation. The seven roles from docs/swarm-patterns.md §1.
// Same model for every agent, different priors — each role's `guidance` is
// prepended to the normal round-robin prompt so the agent has a distinct lens
// before reading the shared transcript.

export interface SwarmRole {
  name: string;
  guidance: string;
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
