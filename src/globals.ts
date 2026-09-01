import { Buffer } from 'buffer';

// @ts-expect-error - third-party libraries expect a Node-like `process` global.
globalThis.process = {
  env: {
    NODE_ENV: import.meta.env.MODE,
  },
};

globalThis.Buffer = Buffer;

// Suppress MaxListenersExceeded warnings from wallet extension content scripts.
// These originate inside the Lace/1AM extensions and cannot be fixed in app code.
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : '')).join(' ');
  if (/MaxListenersExceeded|orphaned data for stream/.test(text)) return;
  origWarn.apply(console, args);
};
