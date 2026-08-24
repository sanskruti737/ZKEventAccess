import { Buffer } from 'buffer';

// @ts-expect-error - third-party libraries expect a Node-like `process` global.
globalThis.process = {
  env: {
    NODE_ENV: import.meta.env.MODE,
  },
};

globalThis.Buffer = Buffer;
