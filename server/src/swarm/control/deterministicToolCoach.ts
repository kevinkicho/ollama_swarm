/**
 * Zero-token tool coach hints for well-known failure modes.
 * Prefer these over an LLM coach when the error fingerprint is unambiguous
 * (Windows bash thrash, overlong grep, tool-loop stuck).
 */

export function deterministicToolCoachHint(tool: string, error: string): string | null {
  const t = (tool || "").toLowerCase();
  const e = error || "";

  if (t === "bash") {
    if (
      /not available as a Windows shell command|not recognized as an internal|is not recognized|wc`|use read, grep, or glob instead|disabled after \d+ consecutive/i
        .test(e)
    ) {
      return (
        "HOST is Windows-class: do not use bash for Unix utilities (wc, grep, cat, find, head, tail, ls, sed, awk). "
        + "Use the built-in read, grep, glob, and list tools for inspection; use propose_hunks / final hunk JSON for edits."
      );
    }
    if (/timeout|killed after/i.test(e)) {
      return (
        "Bash timed out — avoid long-running or interactive commands. Prefer read/grep/glob for inspection, "
        + "and single-purpose, short shell steps only when the todo is kind:build."
      );
    }
    if (/refused|allowlist|not allowed/i.test(e)) {
      return (
        "That bash command is not allowlisted. Prefer read/grep/glob/list, or a narrower command that matches the allowlist."
      );
    }
  }

  if (t === "grep") {
    if (/200 character|pattern too long|too long/i.test(e)) {
      return (
        "Grep pattern is too long. Split into short keywords (<200 chars), or open the file with read and scan the relevant section."
      );
    }
    if (/repeated|identical args|tool loop stuck/i.test(e)) {
      return (
        "Stop repeating the same grep. Change the pattern, narrow the path, or use read on the candidate file."
      );
    }
  }

  if (t === "read" && /not found|ENOENT|does not exist/i.test(e)) {
    return (
      "Path not found. List or glob from the repo root first, then read a path that exists. Do not invent paths."
    );
  }

  if (t === "propose_hunks" || t === "hunks") {
    if (/search.*not found|start.*not found|anchor/i.test(e)) {
      return (
        "Hunk anchor missed the file. Re-read the current file contents, copy an exact unique search/start string, "
        + "or use replace_between/write for large rewrites. Do not re-emit the failed search."
      );
    }
  }

  if (/tool loop exceeded|tool loop stuck/i.test(e)) {
    return (
      "Tool loop exhausted. Stop exploring: emit the final JSON (hunks or skip with a verified reason) on this turn."
    );
  }

  return null;
}
