// 2026-05-03 (Phase A of shared-layer refactor): centralized directive
// helpers. After honoring user directive in 9 presets, every runner
// has the same ~30-40 lines of "directive block / answer-to-directive
// section title / truncated subtitle" boilerplate copied. This module
// is the single source of truth for that idiom — runners use these
// helpers; future presets adding directive support can't drift.
//
// Pure functions, no I/O. Each helper returns a string or array-of-
// strings the caller spreads into its own output structure.
//
// SCOPE: discussion-preset directive plumbing only. Blackboard owns
// its own directive plumbing via PlannerSeed.userDirective + the
// first-pass contract; this module is for the simpler discussion
// presets that just inject directive context into prompts +
// deliverable artifacts.

import type { DeliverableSection } from "./deliverable.js";

/** Trimmed view of cfg.userDirective. `hasDirective` is the canonical
 *  branch predicate — runners should never re-check `directive.length > 0`
 *  themselves. */
export interface DirectiveContext {
  /** The trimmed directive. Empty string when none was supplied. */
  directive: string;
  /** True when a non-empty directive was supplied. */
  hasDirective: boolean;
}

/** Read cfg.userDirective and return a DirectiveContext. Whitespace-only
 *  directives are treated as absent (hasDirective=false). */
export function readDirective(cfg: { userDirective?: string }): DirectiveContext {
  const trimmed = (cfg.userDirective ?? "").trim();
  return { directive: trimmed, hasDirective: trimmed.length > 0 };
}

/** Options for the USER DIRECTIVE block. Both fields optional. */
export interface DirectiveBlockOptions {
  /** Optional clarifier appended inside the delimiter, e.g.
   *  `(the question this OW swarm is answering)`. When set, the open
   *  delimiter becomes `=== USER DIRECTIVE ${labelSuffix} ===`. */
  labelSuffix?: string;
  /** Lines to append after the closing `=== END DIRECTIVE ===` and a
   *  blank line. Each entry becomes its own line. Pass [] (or omit) for
   *  no framing — used by Debate-judge which has no separate framing. */
  framingLines?: readonly string[];
}

/** Build a USER DIRECTIVE block as an array of lines. Returns `[]` when
 *  no directive is set, so callers can unconditionally spread:
 *
 *      const lines = [
 *        ...header,
 *        ...buildDirectiveBlock(ctx, { labelSuffix: "(...)", framingLines: [...] }),
 *        ...rest,
 *      ];
 *
 *  Output shape (when hasDirective):
 *      ["=== USER DIRECTIVE${suffix} ===",
 *       directive,
 *       "=== END DIRECTIVE ===",
 *       "",
 *       ...framingLines,
 *       ""]   // trailing blank only when framingLines is non-empty
 */
export function buildDirectiveBlock(
  ctx: DirectiveContext,
  opts?: DirectiveBlockOptions,
): readonly string[] {
  if (!ctx.hasDirective) return [];
  const labelSuffix = opts?.labelSuffix?.trim();
  const openDelim = labelSuffix
    ? `=== USER DIRECTIVE ${labelSuffix} ===`
    : `=== USER DIRECTIVE ===`;
  const out: string[] = [openDelim, ctx.directive, "=== END DIRECTIVE ===", ""];
  const framing = opts?.framingLines ?? [];
  if (framing.length > 0) {
    for (const line of framing) out.push(line);
    out.push("");
  }
  return out;
}

/** Pick a deliverable doc title that branches on directive presence.
 *  Used by every runner's writeXDeliverable to flip between
 *  "X: directive answer" and "X report". */
export function pickDeliverableTitle(
  ctx: DirectiveContext,
  opts: { withDirective: string; withoutDirective: string },
): string {
  return ctx.hasDirective ? opts.withDirective : opts.withoutDirective;
}

/** Pick a deliverable section title that branches on directive presence.
 *  Used to flip "Final synthesis" → "Answer to directive" etc. */
export function pickAnswerSectionTitle(
  ctx: DirectiveContext,
  opts: { withDirective: string; withoutDirective: string },
): string {
  return ctx.hasDirective ? opts.withDirective : opts.withoutDirective;
}

/** Append a truncated directive snippet to the base subtitle when set,
 *  otherwise return the base subtitle unchanged. Truncation is
 *  word-boundary-naive — it just slices at the limit and adds an
 *  ellipsis. Default maxLen=80. */
export function pickDeliverableSubtitle(
  ctx: DirectiveContext,
  baseSubtitle: string,
  opts?: { maxLen?: number },
): string {
  if (!ctx.hasDirective) return baseSubtitle;
  const maxLen = opts?.maxLen ?? 80;
  const sliced = ctx.directive.slice(0, maxLen);
  const ellipsis = ctx.directive.length > maxLen ? "…" : "";
  return `${baseSubtitle} — directive: "${sliced}${ellipsis}"`;
}

/** Options for the inline `Broader directive: "..."` block (used by
 *  Debate-judge prompt builders, where directive is contextual to the
 *  debated PROPOSITION rather than the primary thing being answered). */
export interface InlineDirectiveBlockOptions {
  /** The clarifier inside the parens, e.g. "the work this debate
   *  informs" → renders as `Broader directive (the work this debate
   *  informs): "<directive>"`. */
  contextLabel: string;
  /** Optional follow-up sentence(s) that explain how the agent should
   *  use the directive context. Each entry becomes its own line. */
  followUpLines?: readonly string[];
}

/** Build a `Broader directive: "..."` inline block as an array of
 *  lines. Returns `[]` when no directive set. Sister to
 *  `buildDirectiveBlock` — same pattern but inline-prose format
 *  rather than `=== USER DIRECTIVE ===` delimiter. Used by Debate-judge
 *  where the directive is broader CONTEXT for the debated proposition,
 *  not the primary question being answered.
 *
 *  Output shape (when hasDirective):
 *      [`Broader directive (<contextLabel>): "<directive>"`,
 *       ...followUpLines,
 *       ""]   // trailing blank only when followUpLines is non-empty
 */
export function buildInlineDirectiveBlock(
  ctx: DirectiveContext,
  opts: InlineDirectiveBlockOptions,
): readonly string[] {
  if (!ctx.hasDirective) return [];
  const out: string[] = [
    `Broader directive (${opts.contextLabel}): "${ctx.directive}"`,
  ];
  const followUp = opts.followUpLines ?? [];
  if (followUp.length > 0) {
    for (const line of followUp) out.push(line);
    out.push("");
  }
  return out;
}

/** Build the optional "Directive" deliverable section. Returns null
 *  when no directive — caller can do:
 *
 *      const dir = maybeDirectiveSection(ctx);
 *      if (dir) sections.push(dir);
 *
 *  Or with the helper below, just append unconditionally. */
export function maybeDirectiveSection(
  ctx: DirectiveContext,
): DeliverableSection | null {
  if (!ctx.hasDirective) return null;
  return { title: "Directive", body: ctx.directive };
}

/** Convenience: prepend a Directive section to a sections array when
 *  hasDirective. Returns a NEW array — does not mutate input. */
export function prependDirectiveSection(
  ctx: DirectiveContext,
  sections: readonly DeliverableSection[],
): DeliverableSection[] {
  const dir = maybeDirectiveSection(ctx);
  return dir ? [dir, ...sections] : [...sections];
}
