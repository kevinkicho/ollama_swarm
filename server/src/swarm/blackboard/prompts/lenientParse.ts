// Lenient pre-processing for LLM JSON responses.
// Instead of dropping items that have slightly-over-size fields,
// truncate/slice to the schema max BEFORE Zod validation so we keep
// the valid core of each item.
//
// Two operations:
//   1. truncateString — slice strings that exceed a max length
//   2. truncateArray  — slice arrays that exceed a max length

// Pre-process a single LLM item (plain object) for lenient extraction.
// Mutations are done on a shallow clone so the original is untouched.
export function lenientPreprocess(
  item: unknown,
  opts: {
    maxDescription?: number;
    maxExpectedFiles?: number;
    maxExpectedAnchors?: number;
    maxExpectedSymbols?: number;
    maxCommand?: number;
    maxRationale?: number;
    maxPreferredTag?: number;
    maxCriteria?: number;
  } = {},
): unknown {
  if (typeof item !== "object" || item === null) return item;
  const obj = item as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };

  if (typeof out.description === "string" && opts.maxDescription) {
    if (out.description.length > opts.maxDescription) {
      out.description = out.description.slice(0, opts.maxDescription - 1).trimEnd() + "\u2026";
    }
  }

  if (Array.isArray(out.expectedFiles) && opts.maxExpectedFiles) {
    if (out.expectedFiles.length > opts.maxExpectedFiles) {
      out.expectedFiles = out.expectedFiles.slice(0, opts.maxExpectedFiles);
    }
  }

  if (Array.isArray(out.expectedAnchors) && opts.maxExpectedAnchors) {
    if (out.expectedAnchors.length > opts.maxExpectedAnchors) {
      out.expectedAnchors = out.expectedAnchors.slice(0, opts.maxExpectedAnchors);
    }
  }

  if (Array.isArray(out.expectedSymbols) && opts.maxExpectedSymbols) {
    if (out.expectedSymbols.length > opts.maxExpectedSymbols) {
      out.expectedSymbols = out.expectedSymbols.slice(0, opts.maxExpectedSymbols);
    }
  }

  if (typeof out.command === "string" && opts.maxCommand) {
    if (out.command.length > opts.maxCommand) {
      out.command = out.command.slice(0, opts.maxCommand);
    }
  }

  if (typeof out.rationale === "string" && opts.maxRationale) {
    if (out.rationale.length > opts.maxRationale) {
      out.rationale = out.rationale.slice(0, opts.maxRationale - 1).trimEnd() + "\u2026";
    }
  }

  if (typeof out.preferredTag === "string" && opts.maxPreferredTag) {
    if (out.preferredTag.length > opts.maxPreferredTag) {
      out.preferredTag = out.preferredTag.slice(0, opts.maxPreferredTag);
    }
  }

  if (Array.isArray(out.criteria) && opts.maxCriteria) {
    if (out.criteria.length > opts.maxCriteria) {
      out.criteria = out.criteria.slice(0, opts.maxCriteria);
    }
  }

  return out;
}

// Soft-cap an array: slice to max instead of rejecting the whole response.
export function softCap<T>(arr: T[], max: number): T[] {
  return arr.length > max ? arr.slice(0, max) : arr;
}