/**
 * Best-effort textual repairs for LLM-emitted JSON that JSON.parse rejects.
 * Shared by parseAgentJson (primary worker path) and server repairJson.
 *
 * Covers failures seen live (83dc5910 / d279548d):
 *   - ```json fences (closed or unclosed)
 *   - smart quotes
 *   - trailing commas
 *   - bare / unquoted keys: {op: "x"} and [op":"x" (missing {" )
 *   - missing closing braces/brackets
 */

/** Strip leading/trailing markdown fences, including unclosed ```json openers. */
export function stripJsonFences(s: string): string {
  let out = s.trim();
  // Fully fenced block
  const fenced = out.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenced) return fenced[1]!.trim();
  // Unclosed leading fence (models often omit the closer on long hunks)
  if (/^```(?:[a-zA-Z0-9_-]+)?\s*\n?/.test(out)) {
    out = out.replace(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?/, "");
    out = out.replace(/\n?```\s*$/, "");
  }
  return out.trim();
}

/**
 * Escape raw control characters inside JSON string literals.
 * Models routinely put real newlines/tabs in search/replace values
 * (2010479c / 120b2044 transcript UI walls: "Bad control character").
 * Safe on valid JSON (already-escaped sequences stay escaped).
 */
export function escapeRawControlCharsInJsonStrings(s: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escape) {
      // Keep the escaped pair as-is (valid or not — later repairs may help).
      out += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      // Other C0 controls (except common whitespace already handled)
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Apply best-effort textual repairs that don't require a real parser.
 * Safe to call on already-valid JSON (identity for clean input).
 */
export function applySoftJsonRepairs(s: string): string {
  let out = s;
  // Smart quotes → ASCII
  out = out.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  // Unicode fancy dashes / non-breaking spaces that break string parses
  out = out.replace(/\u00a0/g, " ").replace(/[\u2010-\u2015]/g, "-");

  // Literal newlines/tabs inside "…" (before bare-key rewrites touch structure)
  out = escapeRawControlCharsInJsonStrings(out);

  // Double-wrapped root: {{"hunks":…}} → {"hunks":…}
  out = out.replace(/^\s*\{\s*(\{\s*"hunks")/i, "$1");
  out = out.replace(/(\]\s*\})\s*\}\s*$/i, "$1");

  // Missing opening brace before a key that already has a trailing quote:
  // Live 83dc5910: {"hunks":[op":"replace",... → {"hunks":[{"op":"replace",...
  out = out.replace(/([\[,]\s*)([A-Za-z_][\w]*)"(\s*:)/g, '$1{"$2"$3');

  // Bare (unquoted) object keys: {op: → {"op":  / ,file: → ,"file":
  // Avoid matching inside already-quoted keys by requiring a structural prefix.
  out = out.replace(/([{\[,]\s*)([A-Za-z_][\w]*)(\s*:)/g, '$1"$2"$3');

  // Single-quoted keys: { 'foo': → { "foo":
  out = out.replace(/([{,]\s*)'([^']+)'(\s*:)/g, '$1"$2"$3');
  // Single-quoted string values: : 'foo' → : "foo"
  out = out.replace(/:\s*'([^'\n]*)'/g, ': "$1"');

  // Trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, "$1");

  // When we inserted `{` for a bare hunk object but the model closed with `"]}`
  // (array then root) instead of `"}]}`, insert the missing object closer.
  // e.g. ..."replace":"y"]} → ..."replace":"y"}]}
  out = closeDanglingObjectBeforeArrayEnd(out);

  // Missing trailing brace/bracket (append-only)
  out = balanceClosingBrackets(out);
  return out;
}

/**
 * If a string value is followed by `]}` but an object is still open inside the
 * array, insert `}` before `]`. Only applied when the result JSON.parses.
 */
function closeDanglingObjectBeforeArrayEnd(s: string): string {
  // Prefer end-of-string (worker envelope) first.
  const endRe = /("(?:[^"\\]|\\.)*")\s*\](\s*\})\s*$/;
  if (endRe.test(s)) {
    const candidate = s.replace(endRe, "$1}]$2");
    if (candidate !== s) {
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        /* fall through */
      }
    }
  }
  // Mid-document: last `"...]` where curly depth is still open after the `]`.
  // Walk and rewrite first bad close.
  let curly = 0;
  let square = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") curly += 1;
    else if (ch === "}") curly -= 1;
    else if (ch === "[") square += 1;
    else if (ch === "]") {
      // Closing array while an object opened after the last `[` is still open.
      if (curly > square) {
        const candidate = s.slice(0, i) + "}" + s.slice(i);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          /* keep scanning */
        }
      }
      square -= 1;
    }
  }
  return s;
}

function balanceClosingBrackets(s: string): string {
  let curlyOpen = 0;
  let squareOpen = 0;
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") curlyOpen += 1;
    else if (ch === "}") curlyOpen -= 1;
    else if (ch === "[") squareOpen += 1;
    else if (ch === "]") squareOpen -= 1;
  }
  let tail = "";
  while (squareOpen-- > 0) tail += "]";
  while (curlyOpen-- > 0) tail += "}";
  return tail ? s + tail : s;
}

/** Try JSON.parse after soft repairs; null if still unparseable. */
export function tryParseWithSoftRepairs(s: string): unknown | null {
  const candidates = [s, stripJsonFences(s)];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* continue */
    }
    // Always try soft repairs (control-char escape may be identity-looking
    // only after fence strip on multi-line hunk blobs).
    const repaired = applySoftJsonRepairs(c);
    try {
      return JSON.parse(repaired);
    } catch {
      /* continue */
    }
    // Second pass: fence-strip after repairs (unclosed ```json mid-blob)
    const again = applySoftJsonRepairs(stripJsonFences(repaired));
    if (again !== repaired) {
      try {
        return JSON.parse(again);
      } catch {
        /* continue */
      }
    }
  }
  return null;
}
