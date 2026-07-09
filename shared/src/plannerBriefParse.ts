export type PlannerBriefSection = {
  title: string;
  body: string;
};

export type ParsedPlannerBrief = {
  leadIn: string;
  title: string | null;
  sections: PlannerBriefSection[];
};

/** Split planner pre-pass prose into lead-in, H2 title, and H3 sections. */
export function parsePlannerBrief(text: string): ParsedPlannerBrief {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return { leadIn: "", title: null, sections: [] };
  }

  const lines = normalized.split("\n");
  const dividerIdx = lines.findIndex((l) => /^---+\s*$/.test(l.trim()));
  const h2Idx = lines.findIndex((l) => l.trim().startsWith("## "));

  let leadIn = "";
  let bodyStart = 0;
  if (dividerIdx >= 0) {
    leadIn = lines.slice(0, dividerIdx).join("\n").trim();
    bodyStart = dividerIdx + 1;
  } else if (h2Idx > 0) {
    leadIn = lines.slice(0, h2Idx).join("\n").trim();
    bodyStart = h2Idx;
  } else if (h2Idx === 0) {
    bodyStart = 0;
  }

  const bodyLines = lines.slice(bodyStart);

  let title: string | null = null;
  let titleLineIdx = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    const t = bodyLines[i]?.trim() ?? "";
    if (t.startsWith("## ")) {
      title = t.slice(3).trim();
      titleLineIdx = i;
      break;
    }
  }

  const sectionLines = titleLineIdx >= 0 ? bodyLines.slice(titleLineIdx + 1) : bodyLines;
  const sections: PlannerBriefSection[] = [];
  let currentTitle: string | null = null;
  let currentBody: string[] = [];

  const flush = () => {
    if (!currentTitle) return;
    sections.push({
      title: currentTitle,
      body: currentBody.join("\n").trim(),
    });
    currentTitle = null;
    currentBody = [];
  };

  for (const line of sectionLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("### ")) {
      flush();
      currentTitle = trimmed.slice(4).trim();
      continue;
    }
    if (trimmed.startsWith("## ")) {
      if (!title) title = trimmed.slice(3).trim();
      continue;
    }
    if (currentTitle) currentBody.push(line);
  }
  flush();

  if (sections.length === 0) {
    const rest = sectionLines.join("\n").trim();
    if (rest) {
      sections.push({
        title: title ?? "Overview",
        body: rest,
      });
    }
  }

  return { leadIn, title, sections };
}

export function plannerBriefSectionCount(text: string): number {
  return parsePlannerBrief(text).sections.length;
}