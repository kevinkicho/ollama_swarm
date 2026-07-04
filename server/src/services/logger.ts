// Simple structured logger with optional runId correlation.
// Replace ad-hoc console.* with this for better debuggability.
//
// Usage:
//   const log = createLogger(runId);
//   log.info('something happened', { extra: 'data' });
//   log.warn('issue', err);

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogContext {
  runId?: string;
  agentId?: string;
  reqId?: string;
  [key: string]: unknown;
}

export function createLogger(defaultContext: LogContext = {}) {
  const base = { ...defaultContext };

  function format(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
    const ts = new Date().toISOString();
    const parts = [`[${ts}]`, `[${level.toUpperCase()}]`];
    if (base.runId) parts.push(`[run:${base.runId.slice(0, 8)}]`);
    if (base.agentId) parts.push(`[agent:${base.agentId}]`);
    if (base.reqId) parts.push(`[req:${base.reqId.slice(0, 8)}]`);
    parts.push(msg);
    if (extra && Object.keys(extra).length > 0) {
      parts.push(JSON.stringify(extra));
    }
    return parts.join(' ');
  }

  return {
    info(msg: string, extra?: Record<string, unknown>) {
      console.log(format('info', msg, extra));
    },
    warn(msg: string, extra?: Record<string, unknown>) {
      console.warn(format('warn', msg, extra));
    },
    error(msg: string, extra?: Record<string, unknown>) {
      console.error(format('error', msg, extra));
    },
    debug(msg: string, extra?: Record<string, unknown>) {
      if (process.env.DEBUG) {
        console.debug(format('debug', msg, extra));
      }
    },
    withContext(additional: Partial<LogContext>) {
      return createLogger({ ...base, ...additional });
    },
  };
}

// Convenience for places without runId yet.
export const rootLogger = createLogger();
