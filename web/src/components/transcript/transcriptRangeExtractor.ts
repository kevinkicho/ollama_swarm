// Virtualizer range extractor for Transcript — extracted from Transcript.tsx.

export function extractTranscriptVirtualRange(
  range: { startIndex: number; endIndex: number },
  opts: {
    listLength: number;
    scrollEl: HTMLElement | null;
    virtualRangeExtra: number;
    virtualRangeScrollPad: number;
  },
): number[] {
  const { listLength, scrollEl, virtualRangeExtra, virtualRangeScrollPad } = opts;
  let start = Math.max(0, range.startIndex - virtualRangeExtra);
  let end = Math.min(listLength - 1, range.endIndex + virtualRangeExtra);

  const avg = 42;
  if (scrollEl) {
    const approxStart = Math.max(0, Math.floor(scrollEl.scrollTop / avg) - virtualRangeScrollPad);
    const approxEnd = Math.min(
      listLength - 1,
      Math.floor((scrollEl.scrollTop + scrollEl.clientHeight) / avg) + virtualRangeScrollPad,
    );
    start = Math.min(start, approxStart);
    end = Math.max(end, approxEnd);
  }

  if (scrollEl && scrollEl.scrollTop < 400) {
    start = 0;
  }

  const tail = Math.max(0, listLength - virtualRangeExtra);
  start = Math.min(start, tail);
  end = Math.max(end, listLength - 1);

  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}
