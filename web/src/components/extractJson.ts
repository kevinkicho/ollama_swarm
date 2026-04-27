// Client-side mirror of server/src/swarm/extractJson.ts. Same logic:
// find the FIRST balanced JSON object/array (depth-counted, string-aware),
// not "first { to last }". Critical for handling models that auto-complete
// chat-template after a real response (gemma4 observed in run b6d91d13).

export function extractFirstBalancedJson(raw: string): string | null {
  const s = raw.trim();
  let firstOpen = -1;
  let openChar = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "{" || c === "[") {
      firstOpen = i;
      openChar = c;
      break;
    }
  }
  if (firstOpen < 0) return null;
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = firstOpen; i < s.length; i++) {
    const c = s.charAt(i);
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (c === "\\") {
        escapeNext = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === openChar) depth += 1;
    else if (c === closeChar) {
      depth -= 1;
      if (depth === 0) return s.slice(firstOpen, i + 1);
    }
  }
  return null;
}
