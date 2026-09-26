export interface Logger {
  trace: (msg: string | object, detail?: string) => void;
  debug: (msg: string | object, detail?: string) => void;
  info: (msg: string | object, detail?: string) => void;
  warn: (msg: string | object, detail?: string) => void;
  error: (msg: string | object, detail?: string) => void;
}

const format = (msg: unknown): unknown =>
  typeof msg === 'string' ? msg : JSON.stringify(msg, (_, v) => (typeof v === 'bigint' ? String(v) : v));

export type LogLevel = 'silent' | 'trace' | 'debug' | 'info';

const RANK: Record<Exclude<LogLevel, 'silent'>, number> = { trace: 0, debug: 1, info: 2 };

/**
 * `warn` and `error` are deliberately NOT filtered by level.
 *
 * `silent` was accepted by the type but suppressed nothing: `info`, `warn` and
 * `error` never consulted it, so asking for a silent logger still printed
 * `[INFO]` — which is how a "quiet" build ends up shipping the same console
 * output as a loud one. `silent` now genuinely silences the three levels that
 * a level threshold governs.
 *
 * `warn` and `error` stay unconditional on purpose. They report a failed
 * transaction, a refused storage write, or a wallet rejection — conditions the
 * user has to be able to diagnose after the fact — and no log level should be
 * able to hide them.
 */
export const consoleLogger = (level: LogLevel = 'info'): Logger => {
  const enabled = (target: number): boolean => level !== 'silent' && target >= RANK[level];
  return {
    trace: (m, d) => {
      if (enabled(0)) console.debug('[TRACE]', format(m), d ?? '');
    },
    debug: (m, d) => {
      if (enabled(1)) console.debug('[DEBUG]', format(m), d ?? '');
    },
    info: (m, d) => {
      if (enabled(2)) console.info('[INFO]', format(m), d ?? '');
    },
    warn: (m, d) => console.warn('[WARN]', format(m), d ?? ''),
    error: (m, d) => console.error('[ERROR]', format(m), d ?? ''),
  };
};
