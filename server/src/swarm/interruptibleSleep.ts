// Promise-based sleep that respects an AbortSignal. Resolves `true`
// when the full delay elapsed naturally, `false` when the signal
// aborted first. Used in the prompt-retry backoff loop and anywhere
// else a long sleep needs to short-circuit on user-stop / cap-trip /
// watchdog. Pre-2026-04-28 this lived as private methods on
// BlackboardRunner + promptWithRetry; consolidated here so both use
// one implementation.

export async function interruptibleSleep(
  ms: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
