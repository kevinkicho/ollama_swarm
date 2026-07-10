/**
 * Fetch helper that attaches SWARM_API_TOKEN when configured.
 * Token sources (first wins):
 *   1. window.__SWARM_API_TOKEN__ (injected)
 *   2. localStorage "swarm_api_token"
 *   3. import.meta.env.VITE_SWARM_API_TOKEN
 */

function resolveToken(): string | undefined {
  if (typeof window !== "undefined") {
    const w = window as Window & { __SWARM_API_TOKEN__?: string };
    if (w.__SWARM_API_TOKEN__?.trim()) return w.__SWARM_API_TOKEN__.trim();
    try {
      const ls = localStorage.getItem("swarm_api_token");
      if (ls?.trim()) return ls.trim();
    } catch {
      /* private mode */
    }
  }
  try {
    const envTok = import.meta.env?.VITE_SWARM_API_TOKEN;
    if (typeof envTok === "string" && envTok.trim()) return envTok.trim();
  } catch {
    /* no vite env */
  }
  return undefined;
}

export function swarmAuthHeaders(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  const tok = resolveToken();
  if (tok) {
    if (!h.has("Authorization")) h.set("Authorization", `Bearer ${tok}`);
    if (!h.has("X-Swarm-Token")) h.set("X-Swarm-Token", tok);
  }
  return h;
}

/** Drop-in fetch for /api/* that adds the optional shared secret. */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = swarmAuthHeaders(init?.headers);
  if (init?.body && !headers.has("Content-Type") && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(input, { ...init, headers });
}

export function swarmWsTokenQuery(): string {
  const tok = resolveToken();
  return tok ? `token=${encodeURIComponent(tok)}` : "";
}
