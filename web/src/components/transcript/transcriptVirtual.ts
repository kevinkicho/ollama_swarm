// Virtualization constants for Transcript — extracted for modularity.
// Virtualization is currently disabled (estimate drift caused hidden rows).

/** Virtualization disabled — estimate drift caused hidden rows and wide gaps on stop. */
export const ENABLE_TRANSCRIPT_VIRTUALIZATION = false;
export const VIRTUALIZE_MIN_COUNT = 500;
export const VIRTUAL_OVERSCAN = 40;
export const VIRTUAL_OVERSCAN_HISTORY = 200;
export const VIRTUAL_RANGE_EXTRA = 80;
export const VIRTUAL_RANGE_EXTRA_HISTORY = 200;
export const VIRTUAL_RANGE_SCROLL_PAD = 80;
export const VIRTUAL_RANGE_SCROLL_PAD_HISTORY = 150;
export const VIRTUAL_TOP_MEASURE_COUNT = 12;

/** Inter-item gap for virtual wrapper stability (px). */
export const TRANSCRIPT_ITEM_GAP_PX = 6;

export const STREAMING_TIMEOUT_MS = 90_000;
