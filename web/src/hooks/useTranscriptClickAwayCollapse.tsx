import {
  useEffect,
  useRef,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";

type CollapseEntry = {
  getRoot: () => HTMLElement | null;
  isExpanded: () => boolean;
  collapse: () => void;
};

const entries = new Set<CollapseEntry>();
let listenerAttached = false;

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  for (const entry of entries) {
    if (!entry.isExpanded()) continue;
    const root = entry.getRoot();
    if (root?.contains(target)) continue;
    entry.collapse();
  }
}

function ensureListener(): void {
  if (listenerAttached) return;
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  listenerAttached = true;
}

function removeListenerIfIdle(): void {
  if (entries.size > 0 || !listenerAttached) return;
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  listenerAttached = false;
}

/**
 * Collapse when the user pointer-downs outside `rootRef` while expanded.
 * Used by transcript bubbles across all swarm presets/modes.
 */
export function useTranscriptClickAwayCollapse(
  rootRef: RefObject<HTMLElement | null>,
  isExpanded: boolean,
  collapse: () => void,
): void {
  const isExpandedRef = useRef(isExpanded);
  const collapseRef = useRef(collapse);
  isExpandedRef.current = isExpanded;
  collapseRef.current = collapse;

  useEffect(() => {
    const entry: CollapseEntry = {
      getRoot: () => rootRef.current,
      isExpanded: () => isExpandedRef.current,
      collapse: () => collapseRef.current(),
    };
    entries.add(entry);
    ensureListener();
    return () => {
      entries.delete(entry);
      removeListenerIfIdle();
    };
  }, [rootRef]);
}

/** Div wrapper that wires click-away collapse for a transcript card. */
export function TranscriptExpandableRoot({
  rootRef,
  expanded,
  onCollapse,
  className,
  style,
  children,
}: {
  rootRef?: MutableRefObject<HTMLDivElement | null>;
  expanded: boolean;
  onCollapse: () => void;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const ref = rootRef ?? localRef;
  useTranscriptClickAwayCollapse(ref, expanded, onCollapse);
  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}