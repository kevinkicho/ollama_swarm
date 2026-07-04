/**
 * Fault injection helpers for reliability testing.
 * Use in tests to simulate network failures, timeouts, provider errors, etc.
 * without affecting production code.
 */

export interface FaultConfig {
  failRate?: number; // 0-1
  delayMs?: number;
  errorMessage?: string;
  timeout?: boolean;
}

let globalFaults: Map<string, FaultConfig> = new Map();

export function injectFault(providerId: string, config: FaultConfig) {
  globalFaults.set(providerId, config);
}

export function clearFaults() {
  globalFaults.clear();
}

export function shouldFail(providerId: string): boolean {
  const cfg = globalFaults.get(providerId);
  if (!cfg) return false;
  if (cfg.failRate !== undefined && Math.random() > cfg.failRate) return false;
  return true;
}

export async function maybeDelay(providerId: string) {
  const cfg = globalFaults.get(providerId);
  if (cfg?.delayMs) {
    await new Promise(r => setTimeout(r, cfg.delayMs));
  }
}

export function getFaultError(providerId: string): Error | null {
  const cfg = globalFaults.get(providerId);
  if (cfg?.errorMessage) {
    return new Error(cfg.errorMessage);
  }
  if (cfg?.timeout) {
    const err = new Error("Injected timeout");
    (err as any).code = "UND_ERR_HEADERS_TIMEOUT";
    return err;
  }
  return null;
}

// Example usage in tests:
// injectFault("ollama", { failRate: 0.3, errorMessage: "simulated outage" });
