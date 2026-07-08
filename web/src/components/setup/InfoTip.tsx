import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FormattedTipContent } from "./FormattedTipContent";

const DEFAULT_MAX_WIDTH = 340;

/** Footer hint line for structured label/value tooltips (recent runs, swarm mode, etc.). */
export const STRUCTURED_TIP_FOOTER_CLASS =
  "text-[10px] text-ink-500 opacity-50 pt-0.5 border-t border-ink-700/40";

export function InfoTip({
  children,
  maxWidth = DEFAULT_MAX_WIDTH,
  trigger,
  wrapperClassName,
  preferNoWrap = false,
  title,
}: {
  children: ReactNode;
  maxWidth?: number;
  /** Custom hover target; defaults to the ⓘ icon. */
  trigger?: ReactNode;
  wrapperClassName?: string;
  /** Grow to content width up to maxWidth / viewport — wrap only when necessary. */
  preferNoWrap?: boolean;
  /** Optional header when children is a plain string. */
  title?: string;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxW: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const maxW = Math.min(maxWidth, window.innerWidth - 16);
    let left = rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - maxW - 8));
    setPos({ top: rect.bottom + 4, left, maxW });
  };

  const scheduleHide = () => {
    hideTimer.current = setTimeout(() => setPos(null), 120);
  };

  const rendered =
    typeof children === "string" ? (
      <FormattedTipContent title={title} body={children} />
    ) : (
      children
    );

  const defaultTriggerClass =
    "ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full border border-violet-700/50 text-violet-300/80 hover:text-violet-200 hover:border-violet-500/70 cursor-help text-[10px] font-mono leading-none align-middle select-none";
  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        className={wrapperClassName ?? (trigger ? "inline" : defaultTriggerClass)}
        aria-label={trigger ? undefined : "More info"}
      >
        {trigger ?? "ⓘ"}
      </span>
      {pos
        ? createPortal(
            <div
              className={`fixed z-50 bg-ink-900 border border-violet-700/60 rounded-md p-3 shadow-xl shadow-violet-950/10 text-xs leading-snug text-ink-300 ${
                preferNoWrap ? "w-max" : ""
              }`}
              style={{
                top: pos.top,
                left: pos.left,
                maxWidth: pos.maxW,
              }}
              onMouseEnter={show}
              onMouseLeave={scheduleHide}
            >
              {rendered}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}