import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Copies compiled ZK key material into public/ so that FetchZkConfigProvider
// can fetch it at `${origin}/keys/<circuit>.prover` etc. in dev and production.
const root = process.cwd();
const managed = join(root, 'managed', 'counter');
const pub = join(root, 'public');

mkdirSync(join(pub, 'keys'), { recursive: true });
mkdirSync(join(pub, 'zkir'), { recursive: true });

cpSync(join(managed, 'keys'), join(pub, 'keys'), { recursive: true });
for (const f of readdirSync(join(managed, 'zkir'))) {
  if (f.endsWith('.bzkir')) {
    cpSync(join(managed, 'zkir', f), join(pub, 'zkir', f));
  }
}
console.log('ZK assets copied to public/');
