// Clipboard write helper. The modern navigator.clipboard.writeText API
// requires a SECURE CONTEXT (HTTPS or localhost). Kevin's WSL setup
// uses http://172.24.x.x:port URLs (non-secure), where
// navigator.clipboard is undefined and any call fails silently — that's
// the "click does nothing" bug. We try modern API first, then fall
// back to the deprecated-but-universally-supported execCommand path
// via a temporary textarea so copies work everywhere the user actually
// hits the app from.
export async function copyText(value: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  // Modern path — secure context only.
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  // Legacy execCommand path — works in non-secure contexts. Uses a
  // throwaway textarea offscreen so the page doesn't visibly flicker.
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
