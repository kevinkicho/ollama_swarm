/**
 * Block web_fetch targets that would reach the local host or private
 * networks (SSRF). Public research use should hit public HTTP(S) only.
 */

import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
]);

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isPrivateOrLocalIpv4(ip: string): boolean {
  const o = parseIpv4Octets(ip);
  if (!o) return true;
  const [a, b] = o;
  // 0.0.0.0/8, 10/8, 127/8
  if (a === 0 || a === 10 || a === 127) return true;
  // 169.254/16 link-local
  if (a === 169 && b === 254) return true;
  // 172.16/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168/16
  if (a === 192 && b === 168) return true;
  // 100.64/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateOrLocalIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  // IPv4-mapped
  if (lower.startsWith(":ffff:")) {
    const v4 = lower.slice(":ffff:".length);
    if (isIP(v4) === 4) return isPrivateOrLocalIpv4(v4);
  }
  return false;
}

export function isBlockedWebFetchUrl(rawUrl: string): { blocked: true; reason: string } | { blocked: false } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { blocked: true, reason: "invalid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { blocked: true, reason: `protocol ${parsed.protocol} not allowed` };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return { blocked: true, reason: "empty hostname" };
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { blocked: true, reason: `hostname ${host} is blocked (SSRF)` };
  }
  // Trailing .localhost etc.
  if (host.endsWith(".localhost") || host.endsWith(".local")) {
    return { blocked: true, reason: `hostname ${host} is blocked (SSRF)` };
  }

  const ipKind = isIP(host);
  // Also treat dotted-quad hostnames as IPv4 even if isIP is picky about forms.
  if ((ipKind === 4 || parseIpv4Octets(host)) && isPrivateOrLocalIpv4(host)) {
    return { blocked: true, reason: `IP ${host} is private/local (SSRF)` };
  }
  if (ipKind === 6 && isPrivateOrLocalIpv6(host)) {
    return { blocked: true, reason: `IP ${host} is private/local (SSRF)` };
  }

  // Decimal / weird forms that resolve to loopback are not fully covered;
  // hostname allow for non-IP is best-effort (no DNS rebinding resolution here).
  return { blocked: false };
}
