import { Field } from "./SharedFields";

// Unit 32: role-diff's customizable role list. Kept in sync with the
// server's DEFAULT_ROLES in server/src/swarm/roles.ts — edits there
// should be mirrored here (and vice versa) so the form's "reset to
// defaults" matches what the server falls back to. The duplication is
// deliberate: adding a `GET /api/defaults/roles` endpoint would be more
// moving parts than this catalog is worth.
export interface SwarmRoleWeb {
  name: string;
  guidance: string;
}
export const DEFAULT_ROLES_WEB: readonly SwarmRoleWeb[] = [
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
];
const MAX_ROLES = 16;
const MAX_ROLE_NAME_LEN = 80;
const MAX_ROLE_GUIDANCE_LEN = 2000;

export function RoleDiffAdvanced({
  roles,
  setRoles,
}: {
  roles: SwarmRoleWeb[];
  setRoles: (r: SwarmRoleWeb[]) => void;
}) {
  const updateAt = (i: number, patch: Partial<SwarmRoleWeb>) => {
    setRoles(roles.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const removeAt = (i: number) => {
    setRoles(roles.filter((_, idx) => idx !== i));
  };
  const addRole = () => {
    if (roles.length >= MAX_ROLES) return;
    setRoles([...roles, { name: "", guidance: "" }]);
  };
  const resetDefaults = () => {
    setRoles(DEFAULT_ROLES_WEB.map((r) => ({ ...r })));
  };

  const atLimit = roles.length >= MAX_ROLES;

  return (
    <div className="text-ink-300 space-y-2">
      <p className="text-ink-400 leading-snug">
        Role differentiation cycles these roles across agents (agent 1 → role 1, agent 2 → role 2,
        …, wrapping). Each role's guidance prepends the round-robin prompt, so identical model
        weights produce distinct priors. Edit, remove, or reset — the server falls back to its own
        defaults if this list is empty.
      </p>
      <div className="flex items-center justify-between text-ink-500">
        <span>
          {roles.length} / {MAX_ROLES} roles
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={resetDefaults}
            className="text-xs px-2 py-0.5 rounded-full bg-ink-700 hover:bg-ink-600 text-ink-300 hover:text-ink-100 border border-ink-600"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={addRole}
            disabled={atLimit}
            className="text-xs px-2 py-0.5 rounded-full bg-ink-700 hover:bg-ink-600 text-ink-300 hover:text-ink-100 border border-ink-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            + Add role
          </button>
        </div>
      </div>
      <div className="space-y-2">
        {roles.map((r, i) => (
          <div
            key={i}
            className="border border-ink-700 rounded px-2 py-2 bg-ink-900/40 space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <span className="text-ink-500 text-xs shrink-0 w-10">#{i + 1}</span>
              <input
                value={r.name}
                maxLength={MAX_ROLE_NAME_LEN}
                onChange={(e) => updateAt(i, { name: e.target.value })}
                className="input flex-1"
                placeholder="Role name (e.g., Architect)"
              />
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`Remove role ${i + 1}`}
                className="shrink-0 text-xs px-2 py-0.5 rounded bg-ink-800 hover:bg-rose-700/50 text-ink-400 hover:text-rose-100 border border-ink-700"
              >
                Remove
              </button>
            </div>
            <textarea
              value={r.guidance}
              maxLength={MAX_ROLE_GUIDANCE_LEN}
              onChange={(e) => updateAt(i, { guidance: e.target.value })}
              rows={2}
              className="input"
              placeholder="Guidance for this role — prepended to the agent's round-robin prompt."
              style={{ fontFamily: "inherit", resize: "vertical", minHeight: 44 }}
            />
          </div>
        ))}
        {roles.length === 0 ? (
          <div className="text-ink-500 italic">
            No custom roles. Leaving empty sends no role list, so the server falls back to its
            default 7-role catalog.
          </div>
        ) : null}
      </div>
    </div>
  );
}
