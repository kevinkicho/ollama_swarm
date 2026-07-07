import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  isWebToolsEnabled,
  toolingMatrix,
  type WebToolsConfig,
} from "../../../shared/src/toolProfiles";
import type { RunConfigSnapshot } from "../types";

function parseMcpNames(spec?: string): string[] {
  if (!spec?.trim()) return [];
  return spec
    .split(/[\s,]+/)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1 ? part.trim() : part.slice(0, eq).trim();
    })
    .filter(Boolean);
}

export function ToolingConfigPanel({ cfg }: { cfg: RunConfigSnapshot }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const toolCfg: WebToolsConfig = {
    webTools: cfg.webTools,
    plannerTools: cfg.plannerTools,
  };
  const webOn = isWebToolsEnabled(toolCfg);
  const mcpNames = parseMcpNames(cfg.mcpServers);
  const rows = toolingMatrix(toolCfg);

  const onEnter = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: Math.max(8, rect.left - 120) });
    setOpen(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={onEnter}
        onMouseLeave={() => setOpen(false)}
        onFocus={onEnter}
        onBlur={() => setOpen(false)}
        className={`inline-flex items-center gap-1 px-1.5 py-px rounded border font-mono text-[10px] transition ${
          webOn
            ? "bg-sky-900/40 text-sky-300 border-sky-800/50"
            : "bg-ink-800/60 text-ink-500 border-ink-700/50"
        }`}
        title="Agent tooling configuration (read-only during run)"
      >
        <span>tools</span>
        <span className="text-[9px]">{webOn ? "web+" : "local"}</span>
      </button>
      {open && pos
        ? createPortal(
            <div
              className="fixed z-[9999] w-[min(420px,calc(100vw-16px))] rounded-lg border border-ink-600 bg-ink-900/95 shadow-2xl backdrop-blur p-3 text-xs font-mono text-ink-200 pointer-events-none"
              style={{ top: pos.top, left: pos.left }}
            >
              <div className="text-[10px] uppercase tracking-wider text-ink-500 mb-2">
                Tooling (frozen at run start)
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                <span
                  className={`px-1.5 py-px rounded border ${
                    webOn
                      ? "bg-emerald-900/40 text-emerald-300 border-emerald-800/50"
                      : "bg-ink-800 text-ink-400 border-ink-700"
                  }`}
                >
                  webTools: {String(cfg.webTools ?? false)}
                </span>
                {cfg.plannerTools != null ? (
                  <span className="px-1.5 py-px rounded border bg-ink-800 text-ink-400 border-ink-700">
                    plannerTools: {String(cfg.plannerTools)}
                  </span>
                ) : null}
                {mcpNames.length > 0 ? (
                  <span className="px-1.5 py-px rounded border bg-violet-900/40 text-violet-300 border-violet-800/50">
                    MCP: {mcpNames.join(", ")}
                  </span>
                ) : null}
              </div>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-ink-500 text-[10px]">
                    <th className="pb-1 pr-2 font-normal">Role</th>
                    <th className="pb-1 pr-2 font-normal">Profile</th>
                    <th className="pb-1 font-normal">Tools</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.role} className="border-t border-ink-800/80">
                      <td className="py-1 pr-2 text-ink-300 whitespace-nowrap">{row.role}</td>
                      <td className="py-1 pr-2 text-sky-300/90 whitespace-nowrap">{row.profile}</td>
                      <td className="py-1 text-ink-400 break-words">
                        {row.tools.length > 0 ? row.tools.join(", ") : "(JSON only)"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[10px] text-ink-500 leading-snug">
                Change tooling on the setup form before starting a new run. Mid-run edits are not applied yet.
              </p>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}