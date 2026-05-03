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
  // T194 (2026-05-04): per-role tool grants. Selects which
  // ToolDispatcher profile this role gets at turn time:
  //   "swarm-read"    — read/grep/glob/list (default for most roles)
  //   "swarm-builder" — adds bash (Tester runs tests, Security checks deps)
  //   "swarm"         — denies everything (deliberate prose-only roles)
  // Optional — defaults to "swarm-read" when absent (preserves
  // pre-T194 behavior). Routed via promptWithRetry's agentName.
  profile?: "swarm-read" | "swarm-builder" | "swarm";
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
    // T194: Tester gets bash so it can actually run the test suite
    // before recommending more tests — grounds claims in real signal.
    profile: "swarm-builder",
  },
  {
    name: "Security reviewer",
    guidance:
      "Look for injection, auth gaps, exposed secrets, supply-chain risk, and unsafe defaults. Cite the specific line or dependency. If you see nothing to flag, say so — don't invent threats.",
    // T194: Security gets bash for dep-graph / lockfile / npm audit
    // queries. Without it the reviewer guesses at supply-chain risk.
    profile: "swarm-builder",
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
    // T194: Dep auditor gets bash for `npm ls` / `npm outdated` /
    // `cargo tree` style queries.
    profile: "swarm-builder",
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
  // T198b (2026-05-04): when true, augment the BUILD_ROLES catalog
  // with directive-specific specialist roles via keyword mapping.
  dynamicRoles?: boolean;
}): readonly SwarmRole[] {
  if (input.customRoles && input.customRoles.length > 0) return input.customRoles;
  const directive = (input.userDirective ?? "").trim();
  const hasDirective = directive.length > 0;
  const baseCatalog = hasDirective ? BUILD_ROLES : DEFAULT_ROLES;
  // T198b dynamic role catalog — first-cut keyword mapping (NOT
  // LLM-driven role picking). When the directive contains specific
  // domain keywords, prepend specialist roles to the base catalog.
  // Real version (deferred) would have the planner emit the role
  // catalog as JSON before the discussion starts.
  if (!input.dynamicRoles || !hasDirective) return baseCatalog;
  const specialists = pickSpecialistRolesFromDirective(directive);
  if (specialists.length === 0) return baseCatalog;
  // Prepend specialists; cap total at 12 so the modulo wrap stays
  // sane for agent counts up to 8 (each agent still gets 1-2 roles).
  return [...specialists, ...baseCatalog].slice(0, 12);
}

// T198b (2026-05-04): keyword → specialist role mapping. First-cut
// catalog of common domain keywords + their specialist role. Pure +
// exported for tests. When the directive contains a keyword from the
// table, the matching specialist is prepended to the role catalog.
// Multiple matches dedup by role name (case-insensitive).
//
// Adding more keywords here is the cheapest way to expand coverage
// — the real fix (LLM-driven role picker) is days of work.
const SPECIALIST_KEYWORDS: ReadonlyArray<{
  pattern: RegExp;
  role: SwarmRole;
}> = [
  {
    pattern: /\bauth(entic\w*|orize)?\b|\blogin\b|\bsession\b|\bjwt\b|\boauth\b/i,
    role: {
      name: "Auth specialist",
      guidance:
        "Auth flows, session management, token handling, password hashing, OAuth integration. Read auth/login/session files first; cite the specific token/cookie/middleware in play.",
      deliverableHint:
        "The auth shape: which scheme (JWT/session/OAuth), where tokens are minted/verified, how expiry is handled, file:line citations.",
    },
  },
  {
    pattern: /\bsecur\w+|\binject\w+|\bxss\b|\bcsrf\b|\bsecret\w*|\bvulnerab/i,
    role: {
      name: "Crypto / Security specialist",
      guidance:
        "Cryptographic primitives in play (hashing, encryption, signing), input-validation gaps, secret-handling risks, supply-chain (dep audit), unsafe defaults. Cite the specific dep + version when flagging.",
      deliverableHint:
        "Specific risks with file:line + severity. If proposing a fix, name the standard pattern (e.g. \"use Argon2id with N=...\" not \"use a strong KDF\").",
    },
  },
  {
    pattern: /\bperformance\b|\bspeed\b|\boptim\w+|\bbenchmark|\bprofil\w+|\blat\w+/i,
    role: {
      name: "Performance / Profiling specialist",
      guidance:
        "Hot paths, N+1 queries, sync I/O on critical paths, accidental quadratics, missing batching/caching. Where would you measure first? Cite the function or call-site.",
      deliverableHint:
        "Profiling proposal: WHAT to instrument, WHERE in the code, WHICH metric matters. Cite file:line.",
    },
  },
  {
    pattern: /\bmigrat\w+|\bschema\b|\bdatabase|\bsql\b|\bmodel\b/i,
    role: {
      name: "Migration / Schema specialist",
      guidance:
        "DB schema changes, backfill plans, rollback paths, online vs offline migrations. Sequence operations safely (additive first, switch readers, drop old). Cite migration tool in use.",
      deliverableHint:
        "Step-by-step migration plan: schema diff + data backfill SQL + reader cutover + rollback. Each step a separate bullet.",
    },
  },
  {
    pattern: /\bcache|\bcaching|\bredis|\bmemcache|\bttl\b/i,
    role: {
      name: "Caching specialist",
      guidance:
        "Where caching belongs, invalidation strategy, key shape, TTL choice, stale-while-revalidate vs strict. Spot stale-data risks Performance might miss.",
      deliverableHint:
        "Cache spec: layer (in-process/Redis/CDN), key, TTL, invalidation triggers, fallback when cache cold.",
    },
  },
  {
    pattern: /\baccessibility|\ba11y|\baria\b|\bwcag/i,
    role: {
      name: "Accessibility specialist",
      guidance:
        "Keyboard nav, ARIA labels, color contrast, screen-reader experience, focus order. Test with the browser's accessibility tree where possible.",
      deliverableHint:
        "WCAG-tagged findings: which guideline (e.g. 2.1.1 Keyboard), what fails, file:line, suggested fix.",
    },
  },
  {
    pattern: /\bapi\b|\brest\b|\bgraphql|\bopenapi|\bswagger/i,
    role: {
      name: "API design specialist",
      guidance:
        "Endpoint shape, status codes, error envelopes, versioning, idempotency. Spot consistency drift across endpoints.",
      deliverableHint:
        "API spec: method + path + req shape + resp shape + status codes + error format. One bullet per endpoint touched.",
    },
  },
];

export function pickSpecialistRolesFromDirective(
  directive: string,
): SwarmRole[] {
  const out: SwarmRole[] = [];
  const seen = new Set<string>();
  for (const entry of SPECIALIST_KEYWORDS) {
    if (entry.pattern.test(directive)) {
      const key = entry.role.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry.role);
    }
  }
  return out;
}
