/**
 * Cheap structural/syntax checks on proposed hunks before autoApprove
 * (or as a pre-gate before LLM review). Catches common model failures:
 * JSX lowercase component, orphan tokens after array close, unbalanced braces.
 * Pure — no I/O, safe for unit tests without loading the full auditor stack.
 */
export function validateProposedHunksStructural(
  hunks: ReadonlyArray<Record<string, unknown>>,
): { ok: boolean; reason: string } {
  for (const h of hunks) {
    // Git-native proposals: disk already mutated; no replace/content to lint.
    const op = typeof h.op === "string" ? h.op : "";
    if (op === "working_tree" || op === "workingTree" || op === "git_commit") {
      continue;
    }
    const file = typeof h.file === "string" ? h.file : "";
    const replace =
      typeof h.replace === "string"
        ? h.replace
        : typeof h.content === "string"
          ? h.content
          : "";
    const search = typeof h.search === "string" ? h.search : "";
    const body = [replace, search].filter(Boolean).join("\n");
    if (!body) continue;

    // React: `const Component = …` then `<component />` — wrong element.
    if (/\.(jsx|tsx)$/i.test(file) || /react/i.test(body)) {
      if (
        /\bconst\s+Component\b/.test(body)
        && /<\s*component\s*\/?\s*>/.test(body)
        && !/<\s*Component\b/.test(body)
      ) {
        return {
          ok: false,
          reason:
            "JSX uses lowercase <component /> after binding `Component` — React will treat it as an HTML tag, not the lazy component",
        };
      }
    }

    // JS/TS: orphan comma/object after a closed array/export (markets.config SEARCH_INDEX).
    if (/\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(file) || !file) {
      if (/\]\s*;\s*\n\s*,/.test(body) || /\]\s*\n\s*,\s*\n\s*\{/.test(body)) {
        return {
          ok: false,
          reason:
            "syntax: content after closed array (e.g. `];` then orphan `, { … }`) — would break module parse",
        };
      }
      // Crude brace balance on replace payload only (search may be partial).
      if (replace) {
        const opens = (replace.match(/\{/g) ?? []).length;
        const closes = (replace.match(/\}/g) ?? []).length;
        if (Math.abs(opens - closes) > 2 && replace.length > 40) {
          return {
            ok: false,
            reason: `syntax: unbalanced braces in replace payload ({${opens} }${closes})`,
          };
        }
      }
    }
  }
  return { ok: true, reason: "" };
}
