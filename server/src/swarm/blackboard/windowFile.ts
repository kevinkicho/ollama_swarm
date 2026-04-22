// Worker prompt size control.
//
// Background (phase11c-medium-v5): the worker user prompt dumps the full
// contents of every expectedFile so the model has enough context to produce
// a diff. A 49KB README (common in non-trivial repos) pushes the prompt past
// 50KB. Combined with Ollama cloud response-generation latency this blew
// past undici's 5-min header timeout on every README-touching todo (c2
// unmet, see summary.json for that run).
//
// Fix: show a head+tail window of any file above a threshold, with a marker
// in the middle that tells the worker the omitted range exists. Workers
// need to see the file's beginning (headings, imports, top-of-file anchors)
// and end (last section, EOF anchors for "append"). Middle edits are less
// common on large files, and when they do come up the worker can still
// succeed by using an anchor that's visible in the head or tail — the
// replace hunk schema enforces exact-single-match so ambiguity fails closed.

// Threshold and head/tail sizes chosen to land a 49KB README under 8KB of
// worker prompt. Head + tail + marker is always ≤ threshold, so crossing
// the threshold always strictly shrinks the prompt.
export const WORKER_FILE_WINDOW_THRESHOLD = 8_000;
export const WORKER_FILE_HEAD_BYTES = 3_000;
export const WORKER_FILE_TAIL_BYTES = 3_000;

export interface WindowedFileView {
  // true when the worker receives the whole file verbatim.
  full: boolean;
  // What to embed in the prompt. On `full=false`, includes the gap marker.
  content: string;
  // Original file size, so the worker prompt can show "49123 chars total"
  // and the model understands what it's not seeing.
  originalLength: number;
}

// Pure function. Deterministic, no I/O, trivially testable.
export function windowFileForWorker(content: string): WindowedFileView {
  const len = content.length;
  if (len <= WORKER_FILE_WINDOW_THRESHOLD) {
    return { full: true, content, originalLength: len };
  }

  const head = content.slice(0, WORKER_FILE_HEAD_BYTES);
  const tail = content.slice(len - WORKER_FILE_TAIL_BYTES);
  const omitted = len - WORKER_FILE_HEAD_BYTES - WORKER_FILE_TAIL_BYTES;

  // Marker is prose so a human reading the prompt transcript understands
  // the view; it also reminds the model that the file is larger than what's
  // shown and suggests anchors that will work.
  const marker =
    `\n\n... [${omitted} chars omitted — file is ${len} chars total. ` +
    `To edit text in the omitted region, use op "append" for end-of-file ` +
    `additions, or use op "replace" with a "search" anchor that is unique ` +
    `and visible in the head or tail shown above/below.] ...\n\n`;

  return { full: false, content: head + marker + tail, originalLength: len };
}
