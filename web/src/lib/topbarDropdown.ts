import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

export type TopbarDropdownPos = { top: number; right: number; width: number };

/** Fixed-position anchor for topbar dropdowns (escapes overflow clipping in the header). */
export function useTopbarDropdown(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  widthPx: number,
  onClose: () => void,
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<TopbarDropdownPos | null>(null);

  const updatePos = useCallback(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const width = Math.min(widthPx, window.innerWidth - 16);
    const right = Math.max(8, window.innerWidth - rect.right);
    setPos({ top: rect.bottom + 4, right, width });
  }, [anchorRef, widthPx]);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePos();
    const onReposition = () => updatePos();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open, onClose, anchorRef]);

  const panelStyle: CSSProperties | undefined = pos
    ? { top: pos.top, right: pos.right, width: pos.width }
    : undefined;

  return { panelRef, pos, panelStyle };
}