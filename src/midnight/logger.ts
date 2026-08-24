export interface Logger {
  trace: (msg: string | object, detail?: string) => void;
  debug: (msg: string | object, detail?: string) => void;
  info: (msg: string | object, detail?: string) => void;
  warn: (msg: string | object, detail?: string) => void;
  error: (msg: string | object, detail?: string) => void;
}

const format = (msg: unknown): unknown =>
  typeof msg === 'string' ? msg : JSON.stringify(msg, (_, v) => (typeof v === 'bigint' ? String(v) : v));

export const consoleLogger = (level: 'silent' | 'trace' | 'debug' | 'info' = 'info'): Logger => {
  const enabled = (target: number) =>
    level !== 'silent' && target >= ({ trace: 0, debug: 1, info: 2 } as Record<string, number>)[level];
  return {
    trace: (m, d) => enabled(0) && console.debug('[TRACE]', format(m), d ?? ''),
    debug: (m, d) => enabled(1) && console.debug('[DEBUG]', format(m), d ?? ''),
    info: (m, d) => console.info('[INFO]', format(m), d ?? ''),
    warn: (m, d) => console.warn('[WARN]', format(m), d ?? ''),
    error: (m, d) => console.error('[ERROR]', format(m), d ?? ''),
  };
};
