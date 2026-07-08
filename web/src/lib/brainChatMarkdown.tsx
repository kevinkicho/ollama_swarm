import type { ReactNode } from "react";

/** Lightweight markdown for Brain chat — no extra deps. */
export function renderBrainChatMarkdown(text: string): ReactNode {
  const blocks = text.split(/\n```([\s\S]*?)```\n?/);
  const nodes: ReactNode[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const chunk = blocks[i];
    if (!chunk) continue;
    if (i % 2 === 1) {
      nodes.push(
        <pre
          key={`code-${i}`}
          className="my-1 px-2 py-1 rounded bg-ink-900/80 border border-ink-700/60 text-[11px] font-mono whitespace-pre-wrap overflow-x-auto"
        >
          {chunk.replace(/^\w+\n/, "")}
        </pre>,
      );
      continue;
    }
    chunk.split("\n").forEach((line, li) => {
      if (!line.trim()) {
        nodes.push(<div key={`${i}-${li}-sp`} className="h-1" />);
        return;
      }
      if (line.startsWith("### ")) {
        nodes.push(
          <div key={`${i}-${li}`} className="text-[11px] font-semibold text-ink-200 mt-1.5 mb-0.5">
            {inlineFormat(line.slice(4))}
          </div>,
        );
        return;
      }
      if (line.startsWith("## ")) {
        nodes.push(
          <div key={`${i}-${li}`} className="text-xs font-semibold text-ink-100 mt-2 mb-0.5">
            {inlineFormat(line.slice(3))}
          </div>,
        );
        return;
      }
      if (line.startsWith("- ")) {
        nodes.push(
          <div key={`${i}-${li}`} className="pl-3 text-ink-300 relative before:content-['•'] before:absolute before:left-0 before:text-ink-500">
            {inlineFormat(line.slice(2))}
          </div>,
        );
        return;
      }
      nodes.push(
        <div key={`${i}-${li}`} className="text-ink-300">
          {inlineFormat(line)}
        </div>,
      );
    });
  }

  return <>{nodes}</>;
}

function inlineFormat(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={idx} className="font-semibold text-ink-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={idx} className="px-0.5 rounded bg-ink-900/70 text-ink-200 font-mono text-[10px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}