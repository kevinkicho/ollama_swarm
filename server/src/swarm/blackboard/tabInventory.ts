/**
 * Disk tab inventory for multi-tab HTML (and similar) files.
 *
 * Live 1963ce25: workers skipped with "file already contains N tabs covering X"
 * while replan still requested topics that were not present. Windowed file views
 * hide the full tab bar, so the model invents counts. Extract a compact ground-
 * truth inventory from full file text and inject it into the worker seed.
 */

export type TabEntry = {
  index: number | null;
  title: string;
};

export type FileTabInventory = {
  path: string;
  tabs: TabEntry[];
  maxIndex: number | null;
};

const TITLE_MAX = 80;
const TABS_PROMPT_CAP = 40;

/** Strip tags / collapse whitespace for a tab label. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);
}

/**
 * Extract tab titles + switchTab indices from HTML-ish content.
 * Handles common patterns:
 *  - role="tab" …>Title</…>
 *  - class="tab" … onclick="switchTab(N)" …>Title</…>
 *  - data-tab / data-tab-index attributes
 */
export function extractTabsFromHtml(content: string): TabEntry[] {
  if (!content || content.length < 20) return [];
  const tabs: TabEntry[] = [];
  const seenTitles = new Set<string>();

  // role="tab" (or role='tab') opening tag through closing tag of same element-ish
  const roleTabRe =
    /<(?<tag>[\w-]+)([^>]*\brole\s*=\s*["']tab["'][^>]*)>([\s\S]*?)<\/\k<tag>>/gi;
  let m: RegExpExecArray | null;
  while ((m = roleTabRe.exec(content)) !== null) {
    const attrs = m[2] ?? "";
    const body = m[3] ?? "";
    const title = cleanTitle(body);
    if (!title || title.length < 1) continue;
    const idx = parseTabIndex(attrs);
    const key = title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    tabs.push({ index: idx, title });
  }

  // Fallback: class containing "tab" + switchTab(N) (not already captured)
  if (tabs.length === 0) {
    const classTabRe =
      /<([\w-]+)([^>]*\bclass\s*=\s*["'][^"']*\btab\b[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi;
    while ((m = classTabRe.exec(content)) !== null) {
      const attrs = m[2] ?? "";
      const body = m[3] ?? "";
      const title = cleanTitle(body);
      if (!title || title.length < 1) continue;
      // Prefer interactive tabs (onclick / switchTab / tabindex)
      if (!/switchTab|onclick|tabindex|aria-selected/i.test(attrs + body)) continue;
      const idx = parseTabIndex(attrs);
      const key = title.toLowerCase();
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      tabs.push({ index: idx, title });
    }
  }

  // If still empty but switchTab indices exist, record index-only entries
  if (tabs.length === 0) {
    const idxSet = new Set<number>();
    for (const sm of content.matchAll(/switchTab\s*\(\s*(\d+)\s*\)/g)) {
      idxSet.add(Number(sm[1]));
    }
    for (const i of [...idxSet].sort((a, b) => a - b)) {
      tabs.push({ index: i, title: `tab-${i}` });
    }
  }

  return tabs;
}

function parseTabIndex(attrs: string): number | null {
  const switchM = attrs.match(/switchTab\s*\(\s*(\d+)\s*\)/i);
  if (switchM) return Number(switchM[1]);
  const dataM = attrs.match(/\bdata-tab(?:-index)?\s*=\s*["'](\d+)["']/i);
  if (dataM) return Number(dataM[1]);
  const ariaM = attrs.match(/\baria-controls\s*=\s*["'][^"']*?(\d+)["']/i);
  if (ariaM) return Number(ariaM[1]);
  return null;
}

/** True when the work item likely needs tab inventory (HTML multi-tab pages). */
export function todoLikelyNeedsTabInventory(
  description: string,
  expectedFiles: readonly string[],
): boolean {
  const d = description.toLowerCase();
  if (/\btabs?\b|\btab bar\b|\btablist\b|switchtab|canvas animation/i.test(d)) {
    return true;
  }
  return expectedFiles.some((f) => /\.html?$/i.test(f));
}

/**
 * Pick HTML (and similar) paths most relevant to a directive for inventory.
 * Prefer basename keyword hits; fall back to first N html files.
 */
export function selectPathsForTabInventory(
  repoFiles: readonly string[],
  directive?: string,
  maxFiles: number = 8,
): string[] {
  const html = repoFiles.filter((f) => /\.html?$/i.test(f));
  if (html.length === 0) return [];
  const d = (directive ?? "").toLowerCase();
  const tokens = d
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length >= 4 && !/^(html|file|page|with|from|that|this|into|tabs?)$/i.test(t));
  if (tokens.length === 0 || !d.trim()) {
    return html.slice(0, maxFiles);
  }
  const scored = html.map((p) => {
    const base = p.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (base.includes(t)) score += 3;
    }
    if (/\btab\b|switchtab|role=.tab/i.test(base)) score += 1;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score || a.p.localeCompare(b.p));
  const hits = scored.filter((s) => s.score > 0).map((s) => s.p);
  if (hits.length > 0) return hits.slice(0, maxFiles);
  return html.slice(0, maxFiles);
}

/** Whether planner/first-pass should load tab inventory for this directive/repo. */
export function seedLikelyNeedsTabInventory(
  directive: string | undefined,
  repoFiles: readonly string[],
): boolean {
  const d = (directive ?? "").toLowerCase();
  if (/\btabs?\b|\btab bar\b|\btablist\b|switchtab|canvas animation|\.html\b/i.test(d)) {
    return true;
  }
  // Many multi-page HTML education/demo repos without "tab" in the directive.
  const htmlCount = repoFiles.filter((f) => /\.html?$/i.test(f)).length;
  return htmlCount >= 3 && (/\badd\b|\bnew\b|\bexpand\b|\banimation/i.test(d) || htmlCount >= 8);
}

/**
 * Read selected paths and build a renderable inventory block.
 * `readFile` returns null when missing.
 */
export async function loadTabInventoryBlock(
  paths: readonly string[],
  readFile: (path: string) => Promise<string | null>,
): Promise<string | undefined> {
  if (paths.length === 0) return undefined;
  const contents: Record<string, string | null> = {};
  for (const p of paths) {
    try {
      contents[p] = await readFile(p);
    } catch {
      contents[p] = null;
    }
  }
  const inventories = buildTabInventories(contents, paths);
  const block = renderTabInventoryBlock(inventories);
  return block || undefined;
}

export function buildTabInventories(
  fileContents: Record<string, string | null | undefined>,
  paths?: readonly string[],
): FileTabInventory[] {
  const keys = paths?.length ? paths : Object.keys(fileContents);
  const out: FileTabInventory[] = [];
  for (const path of keys) {
    const content = fileContents[path];
    if (content == null || content.length < 40) continue;
    // Cheap gate: only parse files that look tab-ish
    if (!/\brole\s*=\s*["']tab["']|\bswitchTab\s*\(|class\s*=\s*["'][^"']*\btab\b/i.test(content)) {
      continue;
    }
    const tabs = extractTabsFromHtml(content);
    if (tabs.length === 0) continue;
    const indices = tabs.map((t) => t.index).filter((i): i is number => i != null);
    out.push({
      path,
      tabs,
      maxIndex: indices.length > 0 ? Math.max(...indices) : null,
    });
  }
  return out;
}

/** Compact prompt block for worker seed. */
export function renderTabInventoryBlock(inventories: readonly FileTabInventory[]): string {
  if (inventories.length === 0) return "";
  const lines: string[] = [
    "## Disk tab inventory (GROUND TRUTH — use before claiming tabs already exist)",
    "Counts and titles below are extracted from full file text, not the windowed view.",
    "Only skip for missing topics if EVERY requested topic title (or clear synonym) appears below.",
    "If the TODO asks for new topics not listed, ADD them — do not skip.",
  ];
  for (const inv of inventories) {
    const n = inv.tabs.length;
    const maxLabel = inv.maxIndex != null ? `, max switchTab index ${inv.maxIndex}` : "";
    lines.push("");
    lines.push(`### ${inv.path} — ${n} tab(s)${maxLabel}`);
    const shown = inv.tabs.slice(0, TABS_PROMPT_CAP);
    for (const t of shown) {
      const idx = t.index != null ? String(t.index) : "?";
      lines.push(`  [${idx}] ${t.title}`);
    }
    if (inv.tabs.length > TABS_PROMPT_CAP) {
      lines.push(`  … +${inv.tabs.length - TABS_PROMPT_CAP} more`);
    }
  }
  return lines.join("\n");
}

/**
 * Topics mentioned in a todo description that look like requested tab titles.
 * Heuristic: quoted phrases, "tabs for X, Y, and Z", "Add N new tabs … for A, B".
 */
export function extractRequestedTabTopics(description: string): string[] {
  const topics: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = s
      .replace(/\s+/g, " ")
      .replace(/^[\s(]+|[\s).;:]+$/g, "")
      .trim()
      .slice(0, TITLE_MAX);
    if (t.length < 3) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    // Drop generic noise
    if (
      /^(tabs?|new|add|with|unique|canvas|animations?|sidebar|controls?|panels?|proof|katex)$/i.test(
        t,
      )
    ) {
      return;
    }
    seen.add(key);
    topics.push(t);
  };

  for (const m of description.matchAll(/["']([^"']{3,80})["']/g)) {
    push(m[1] ?? "");
  }
  // Parenthetical topic lists: (Riemann curvature, geodesic deviation, …)
  for (const m of description.matchAll(/\(([^)]{8,300})\)/g)) {
    const inner = m[1] ?? "";
    if (/,/.test(inner) || /\band\b/i.test(inner)) {
      for (const part of inner.split(/,|\band\b|\bor\b/i)) {
        push(part);
      }
    }
  }
  // Comma lists after "for" / "tabs" even when mixed with quotes:
  // Add tabs for "Riemann curvature", geodesic deviation, and parallel transport
  const listAnchor = description.match(
    /\b(?:tabs?\s+(?:for|covering)|for|covering|about|topics?:)\s+(.{5,280}?)(?:\s+with\b|\s*$)/i,
  );
  if (listAnchor?.[1]) {
    const chunk = listAnchor[1]
      .replace(/["']/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (/,/.test(chunk) || /\band\b/i.test(chunk)) {
      for (const part of chunk.split(/,|\band\b|\bor\b/i)) {
        push(part);
      }
    }
  }
  return topics.slice(0, 12);
}

function normalizeTopicKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function topicCoveredByInventory(topic: string, tabs: readonly TabEntry[]): boolean {
  const t = normalizeTopicKey(topic);
  const tokens = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  for (const tab of tabs) {
    const title = normalizeTopicKey(tab.title);
    if (title.includes(t) || t.includes(title)) return true;
    // Token overlap: ≥2 significant tokens match, or 1 if topic is short
    if (tokens.length === 0) continue;
    const hits = tokens.filter((tok) => title.includes(tok)).length;
    if (tokens.length === 1 && hits >= 1) return true;
    if (hits >= 2 || (tokens.length >= 2 && hits / tokens.length >= 0.6)) return true;
  }
  return false;
}

/**
 * Deterministic check: skip claims "already done / already contains tabs"
 * but requested topics are missing from disk inventory → refuse the skip.
 */
export function tabSkipContradictsInventory(
  skipReason: string,
  todoDescription: string,
  inventories: readonly FileTabInventory[],
): { contradicts: true; missing: string[]; detail: string } | { contradicts: false } {
  if (inventories.length === 0) return { contradicts: false };
  const reason = skipReason.toLowerCase();
  const looksAlreadyDone =
    /already (contains|has|covers|implement)|already present|already done|no (additional |further )?changes? needed|all .* already|complete|nothing to (add|do)/i.test(
      reason,
    );
  if (!looksAlreadyDone && !/tabs?/i.test(reason)) return { contradicts: false };

  const topics = extractRequestedTabTopics(todoDescription);
  if (topics.length === 0) return { contradicts: false };

  const allTabs = inventories.flatMap((i) => i.tabs);
  const missing = topics.filter((t) => !topicCoveredByInventory(t, allTabs));
  if (missing.length === 0) return { contradicts: false };

  // If skip claims a tab count that is wildly off inventory, also flag.
  const claimCount = reason.match(/(\d+)\s*tabs?/);
  const diskCount = inventories.reduce((n, i) => n + i.tabs.length, 0);
  const countNote =
    claimCount && Math.abs(Number(claimCount[1]) - diskCount) >= 3
      ? ` (skip claimed ${claimCount[1]} tabs; disk has ${diskCount})`
      : "";

  return {
    contradicts: true,
    missing,
    detail:
      `Skip claims work already done, but disk tab inventory is missing: ${missing
        .map((m) => JSON.stringify(m))
        .join(", ")}${countNote}. Add missing tabs instead of skipping.`,
  };
}
