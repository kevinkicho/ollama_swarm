import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FormattedTipContent } from "./FormattedTipContent";

const DEFAULT_MAX_WIDTH = 340;

/** Footer hint line for structured label/value tooltips (recent runs, swarm mode, etc.). */
export const STRUCTURED_TIP_FOOTER_CLASS =
  "text-[10px] text-ink-500 opacity-50 pt-0.5 border-t border-ink-700/40";

const DEFAULT_SHOW_DELAY_MS = 2000;
const CURSOR_OFFSET_PX = 12;
const VIEWPORT_PADDING_PX = 8;

function positionAtCursor(
  x: number,
  y: number,
  maxW: number,
  fallback?: DOMRect,
): { top: number; left: number; maxW: number } {
  let left = x + CURSOR_OFFSET_PX;
  let top = y + CURSOR_OFFSET_PX;
  if (left + maxW > window.innerWidth - VIEWPORT_PADDING_PX) {
    left = x - maxW - CURSOR_OFFSET_PX;
  }
  left = Math.max(
    VIEWPORT_PADDING_PX,
    Math.min(left, window.innerWidth - maxW - VIEWPORT_PADDING_PX),
  );
  const maxTop = window.innerHeight - VIEWPORT_PADDING_PX - 48;
  if (top > maxTop && fallback) {
    top = Math.max(VIEWPORT_PADDING_PX, fallback.top - CURSOR_OFFSET_PX);
  } else {
    top = Math.max(VIEWPORT_PADDING_PX, Math.min(top, maxTop));
  }
  return { top, left, maxW };
}

export function InfoTip({
  children,
  maxWidth = DEFAULT_MAX_WIDTH,
  trigger,
  wrapperClassName,
  preferNoWrap = false,
  title,
  showDelayMs = DEFAULT_SHOW_DELAY_MS,
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
  /** Milliseconds to wait after hover before showing the tooltip. */
  showDelayMs?: number;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxW: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearShowTimer = () => {
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  };

  const trackCursor = (e: React.MouseEvent) => {
    cursorRef.current = { x: e.clientX, y: e.clientY };
  };

  const show = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    const maxW = Math.min(maxWidth, window.innerWidth - 16);
    const fallback = triggerRef.current?.getBoundingClientRect();
    const cursor = cursorRef.current;
    if (cursor) {
      setPos(positionAtCursor(cursor.x, cursor.y, maxW, fallback));
    } else if (fallback) {
      setPos(
        positionAtCursor(
          fallback.left + fallback.width / 2,
          fallback.top + fallback.height / 2,
          maxW,
          fallback,
        ),
      );
    }
  };

  const keepVisible = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const scheduleShow = (e: React.MouseEvent) => {
    trackCursor(e);
    clearShowTimer();
    showTimer.current = setTimeout(show, showDelayMs);
  };

  const scheduleHide = () => {
    clearShowTimer();
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
        onMouseEnter={scheduleShow}
        onMouseMove={trackCursor}
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
              onMouseEnter={keepVisible}
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