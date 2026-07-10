import { useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { FormattedTipContent } from "./FormattedTipContent";

const DEFAULT_MAX_WIDTH = 340;

/** Footer hint line for structured label/value tooltips (recent runs, swarm mode, etc.). */
export const STRUCTURED_TIP_FOOTER_CLASS =
  "text-[10px] text-ink-500 opacity-50 pt-0.5 border-t border-ink-700/40";

const DEFAULT_SHOW_DELAY_MS = 2000;
const CURSOR_OFFSET_PX = 12;
const VIEWPORT_PADDING_PX = 8;
const EST_TIP_HEIGHT_PX = 180;

function positionAtCursor(
  x: number,
  y: number,
  requestedMaxW: number,
): { top: number; left: number; maxW: number } {
  const pad = VIEWPORT_PADDING_PX;
  const off = CURSOR_OFFSET_PX;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let maxW = Math.min(requestedMaxW, vw - pad * 2);
  let left = x + off;

  if (left + maxW > vw - pad) {
    maxW = Math.min(maxW, Math.max(120, x - off - pad));
    left = Math.max(pad, x - maxW - off);
  }

  let top = y + off;
  if (top + EST_TIP_HEIGHT_PX > vh - pad) {
    top = y - EST_TIP_HEIGHT_PX - off;
  }
  top = Math.max(pad, Math.min(top, vh - pad - 48));

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
  const triggerRef = useRef<HTMLElement | null>(null);
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

  const applyCursorPosition = (x: number, y: number) => {
    const maxW = Math.min(maxWidth, window.innerWidth - 16);
    setPos(positionAtCursor(x, y, maxW));
  };

  const trackCursor = (e: React.MouseEvent) => {
    cursorRef.current = { x: e.clientX, y: e.clientY };
    if (pos) applyCursorPosition(e.clientX, e.clientY);
  };

  const show = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    const cursor = cursorRef.current;
    if (cursor) {
      applyCursorPosition(cursor.x, cursor.y);
      return;
    }
    const fallback = triggerRef.current?.getBoundingClientRect();
    if (fallback) {
      applyCursorPosition(
        fallback.left + fallback.width / 2,
        fallback.top + fallback.height / 2,
      );
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

  const hoverProps = {
    onMouseEnter: scheduleShow,
    onMouseMove: trackCursor,
    onMouseLeave: scheduleHide,
  };

  // Always own the hover shell ourselves. Avoid cloneElement + props.ref —
  // React treats `ref` as special; reading/passing it as a normal prop warns
  // (and breaks child refs like chatScrollRef on the Brain chat pane).
  const triggerNode: ReactNode = trigger ? (
    <span
      ref={triggerRef as Ref<HTMLSpanElement>}
      {...hoverProps}
      className={[wrapperClassName, "cursor-help"].filter(Boolean).join(" ") || "inline cursor-help"}
    >
      {trigger}
    </span>
  ) : (
    <span
      ref={triggerRef as Ref<HTMLSpanElement>}
      {...hoverProps}
      className={wrapperClassName ?? defaultTriggerClass}
      aria-label="More info"
    >
      ⓘ
    </span>
  );

  return (
    <>
      {triggerNode}
      {pos
        ? createPortal(
            <div
              className={`fixed z-[60] bg-ink-900 border border-violet-700/60 rounded-md p-3 shadow-xl shadow-violet-950/10 text-xs leading-snug text-ink-300 pointer-events-none ${
                preferNoWrap ? "w-max" : ""
              }`}
              style={{
                top: pos.top,
                left: pos.left,
                maxWidth: pos.maxW,
              }}
            >
              {rendered}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}