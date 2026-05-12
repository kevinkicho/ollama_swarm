import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_MAX_WIDTH = 340;

export function InfoTip({ children }: { children: ReactNode }) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const show = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - TOOLTIP_MAX_WIDTH - 16);
    setPos({ top: rect.bottom + 4, left });
  };
  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={() => setPos(null)}
        className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full border border-ink-600 text-ink-400 hover:text-ink-200 hover:border-ink-400 cursor-help text-[10px] font-mono leading-none align-middle select-none"
        aria-label="More info"
      >
        ⓘ
      </span>
      {pos
        ? createPortal(
            <div
              className="fixed z-50 bg-ink-900 border border-ink-600 rounded-md p-3 shadow-xl text-xs leading-snug text-ink-300"
              style={{ top: pos.top, left: pos.left, maxWidth: TOOLTIP_MAX_WIDTH }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}