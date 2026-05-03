// 2026-05-02 (onboarding lever #3): click-to-fill starter directives.
// Lets a first-time user kick a useful run without authoring the
// directive themselves. Each starter targets a small public repo + a
// preset that's known to handle the task class well.
//
// Each starter is independent — picking one fills (repoUrl, preset,
// directive). Clears any prior unsaved entry. Doesn't auto-submit;
// the user still hits Start so they see what's about to fire.
//
// Curated, not exhaustive — small enough that newcomers can read all
// of them in 5 seconds. Add more once we have data on which ones
// actually get used.

export interface StarterDirective {
  /** Stable id for the click handler. */
  id: string;
  /** One-line label for the button. */
  label: string;
  /** Two-line summary shown on hover. */
  summary: string;
  /** Pre-fills the repoUrl field. Public repos only — must clone
   *  without auth to keep first-run friction low. */
  repoUrl: string;
  /** Preset id from PRESETS — must match an entry in
   *  setup/presets.ts so the form's preset switch fires correctly. */
  presetId: string;
  /** The actual directive text the user can edit before submitting. */
  directive: string;
  /** Why this starter is worth trying — surfaced in the tooltip. */
  whyTry: string;
}

export const STARTER_DIRECTIVES: readonly StarterDirective[] = [
  {
    id: "audit-readme",
    label: "Audit a README",
    summary: "Verify README claims against actual code (analysis-only)",
    repoUrl: "https://github.com/sindresorhus/got",
    presetId: "moa",
    directive:
      "Read the README. For each feature it claims, verify the code actually implements that feature. List specific discrepancies between docs and code, with file paths.",
    whyTry: "Good first run — discussion-only, no commits, finishes in 2-3 minutes per round. Lets you see how MoA's proposers + aggregator work together.",
  },
  {
    id: "small-refactor",
    label: "Tiny refactor task",
    summary: "Add input validation to a small public repo (blackboard preset)",
    repoUrl: "https://github.com/sindresorhus/is-odd",
    presetId: "blackboard",
    directive:
      "Add a runtime check: when the input isn't a number, throw a TypeError with a clear message. Update the README to mention the new error behavior. Keep changes minimal.",
    whyTry: "See how the planner breaks a small task into TODOs and the workers commit each fix. Real file changes, real git commits, real verify gate.",
  },
  {
    id: "architecture-decision",
    label: "Architecture decision",
    summary: "Multi-perspective evaluation (council preset)",
    repoUrl: "https://github.com/expressjs/express",
    presetId: "council",
    directive:
      "Evaluate whether this project should ship a built-in async error handler (current behavior requires user wrap). Consider backward compatibility, ecosystem expectations, and migration cost. Produce a clear recommendation.",
    whyTry: "Council's parallel-then-revise pattern shines when there's a real tradeoff to discuss. Discussion-only; no commits.",
  },
  {
    id: "stigmergy-coverage",
    label: "Test coverage map",
    summary: "Walk a repo and identify test gaps (stigmergy preset)",
    repoUrl: "https://github.com/sindresorhus/got",
    presetId: "stigmergy",
    directive:
      "For each source module, identify whether it has corresponding tests and what fraction of its surface is covered. Produce a coverage table prioritized by which gaps are user-facing.",
    whyTry: "Stigmergy's pheromone-trail design fits repo-walks naturally; you'll see agents leave notes for each other across files.",
  },
] as const;
