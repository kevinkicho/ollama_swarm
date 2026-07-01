// AuditReviewCard.tsx — Structured card for audit reviews
// Parses audit review text into sections (Progress, Gaps, Issues, Next)
// and renders them as a styled card with icons.
// Collapsed by default to save screen space.

import { useState } from "react";

interface AuditReviewCardProps {
  text: string;
  agentIndex?: number;
  ts: number;
}

interface AuditSection {
  label: string;
  icon: string;
  color: string;
  bgColor: string;
  content: string;
}

function parseAuditReview(text: string): AuditSection[] {
  const sections: AuditSection[] = [];

  // Extract sections using regex patterns
  const progressMatch = text.match(/(?:##?\s*)?What was accomplished[:\s]*(.*?)(?=##?\s*(?:What's|Quality|Alignment|Recommended|Gaps|Issues)|$)/is);
  const gapsMatch = text.match(/(?:##?\s*)?(?:What's missing|Gaps?)[:\s]*(.*?)(?=##?\s*(?:Quality|Alignment|Recommended|Issues)|$)/is);
  const issuesMatch = text.match(/(?:##?\s*)?(?:Quality issues|Issues?|Contradictions?)[:\s]*(.*?)(?=##?\s*(?:Alignment|Recommended|Gaps)|$)/is);
  const nextMatch = text.match(/(?:##?\s*)?(?:Recommended|Next)[:\s]*(.*?)(?=##?\s*(?:What's|Quality|Alignment|Gaps|Issues)|$)/is);
  const alignmentMatch = text.match(/(?:##?\s*)?Alignment[:\s]*(.*?)(?=##?\s*(?:Recommended|Next|Gaps|Issues)|$)/is);

  if (progressMatch?.[1]?.trim()) {
    sections.push({
      label: "Progress",
      icon: "✅",
      color: "text-emerald-400",
      bgColor: "bg-emerald-950/30 border-emerald-700/40",
      content: progressMatch[1].trim(),
    });
  }

  if (gapsMatch?.[1]?.trim() && !gapsMatch[1].trim().match(/^none/i)) {
    sections.push({
      label: "Gaps",
      icon: "⚠️",
      color: "text-amber-400",
      bgColor: "bg-amber-950/30 border-amber-700/40",
      content: gapsMatch[1].trim(),
    });
  }

  if (issuesMatch?.[1]?.trim() && !issuesMatch[1].trim().match(/^none/i)) {
    sections.push({
      label: "Issues",
      icon: "❌",
      color: "text-rose-400",
      bgColor: "bg-rose-950/30 border-rose-700/40",
      content: issuesMatch[1].trim(),
    });
  }

  if (alignmentMatch?.[1]?.trim()) {
    sections.push({
      label: "Alignment",
      icon: "🎯",
      color: "text-blue-400",
      bgColor: "bg-blue-950/30 border-blue-700/40",
      content: alignmentMatch[1].trim(),
    });
  }

  if (nextMatch?.[1]?.trim() && !nextMatch[1].trim().match(/^none/i)) {
    sections.push({
      label: "Next",
      icon: "→",
      color: "text-cyan-400",
      bgColor: "bg-cyan-950/30 border-cyan-700/40",
      content: nextMatch[1].trim(),
    });
  }

  // If no sections parsed, return the full text as a single section
  if (sections.length === 0) {
    sections.push({
      label: "Review",
      icon: "📝",
      color: "text-ink-300",
      bgColor: "bg-ink-800/50 border-ink-600/40",
      content: text,
    });
  }

  return sections;
}

export function AuditReviewCard({ text, agentIndex, ts }: AuditReviewCardProps) {
  const [expanded, setExpanded] = useState(false);
  const sections = parseAuditReview(text);
  const time = new Date(ts).toLocaleTimeString();

  // Summary: first section content truncated
  const summaryText = sections.length > 0 ? sections[0].content.slice(0, 150) + "..." : "Review";

  return (
    <div className="rounded-lg border border-ink-600/50 bg-ink-900/50 overflow-hidden">
      {/* Header with expand/collapse toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-ink-800/50 border-b border-ink-700/30 hover:bg-ink-700/50 transition-colors"
      >
        <span className="text-sm">🔍</span>
        <span className="text-xs font-medium text-ink-300">
          {agentIndex ? `Agent ${agentIndex}` : "Agent"} Audit Review
        </span>
        <span className="text-[10px] text-ink-500">· {time}</span>
        <span className="text-[10px] text-ink-500 ml-auto">
          {expanded ? "▼ collapse" : "▶ expand"}
        </span>
      </button>

      {/* Summary when collapsed */}
      {!expanded && (
        <div className="px-3 py-2 text-xs text-ink-400">
          {summaryText}
        </div>
      )}

      {/* Full sections when expanded */}
      {expanded && (
        <div className="p-3 space-y-2">
          {sections.map((section, i) => (
            <div key={i} className={`rounded border px-3 py-2 ${section.bgColor}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm">{section.icon}</span>
                <span className={`text-xs font-medium ${section.color}`}>{section.label}</span>
              </div>
              <div className="text-xs text-ink-300 leading-relaxed whitespace-pre-wrap">
                {section.content}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
