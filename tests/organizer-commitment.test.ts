import { describe, it, expect } from 'vitest';
import {
  createCircuitContext,
  createConstructorContext,
  CompactTypeBytes,
  CompactTypeVector,
  persistentHash,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { Contract, ledger } from '../managed/zk-event-access/contract/index.js';
import { witnesses, createZKEventAccessPrivateState } from '../src/witnesses.js';
import { organizerCommitment } from '../src/midnight/zk-event-access-api.js';

const SECRET = new Uint8Array(32).fill(7);

/** pad(32, "zkEventAccess:organizer") — the contract's domain separator. */
const DOMAIN = new Uint8Array([
  122, 107, 69, 118, 101, 110, 116, 65, 99, 99, 101, 115, 115, 58, 111, 114, 103, 97, 110, 105, 122, 101, 114, 0, 0,
  0, 0, 0, 0, 0, 0, 0,
]);

/** Deploys the real contract in the simulator and returns its public ledger. */
function deployAndReadLedger(): { organizer: string; contractAddress: string } {
  const contract = new Contract(witnesses);
  const init = contract.initialState(
    createConstructorContext(createZKEventAccessPrivateState(SECRET), {
      bytes: new Uint8Array(32),
    }),
  );
  const ctx = createCircuitContext(
    sampleContractAddress(),
    init.currentZswapLocalState,
    init.currentContractState,
    init.currentPrivateState,
  );
  const l = ledger(ctx.currentQueryContext.state);
  return { organizer: toHex(l.organizer), contractAddress: toHex(l.contractAddress) };
}

/** The OLD off-chain mirror: persistentHash<Vector<2, Bytes<32>>>([domain, sk]) — no contract address. */
const legacyMirror = (): string =>
  toHex(
    new Uint8Array(
      persistentHash(new CompactTypeVector(2, new CompactTypeBytes(32)), [DOMAIN, SECRET]),
    ),
  );

/** The contract's real hash: persistentHash<Vector<3, Bytes<32>>>([domain, contractAddress, sk]). */
const contractMirror = (contractAddress: string): string => {
  const addr = Uint8Array.from(
    (contractAddress.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)),
  );
  return toHex(
    new Uint8Array(
      persistentHash(new CompactTypeVector(3, new CompactTypeBytes(32)), [DOMAIN, addr, SECRET]),
    ),
  );
};

describe('off-chain organizer commitment mirror', () => {
  it('reproduces the on-chain organizer exactly (regression for the Vector<2> bug)', () => {
    const { organizer, contractAddress } = deployAndReadLedger();

    // This is the assertion that FAILED before the fix: the off-chain mirror is
    // now built from the same domain-separated, address-bound hash the contract
    // uses, so the pre-flight organizer check compares like with like.
    expect(organizerCommitment(SECRET, contractAddress).toLowerCase()).toBe(organizer.toLowerCase());
  });

  it('confirms the old Vector<2> mirror is what produced the false mismatch', () => {
    const { organizer } = deployAndReadLedger();
    // The legacy mirror omits contractAddress, so it can never equal the
    // on-chain value — this is exactly the bug behind the reported
    // "on-chain organizer != connected wallet" error.
    expect(legacyMirror().toLowerCase()).not.toBe(organizer.toLowerCase());
  });

  it('binds the commitment to the contract address (same key, different event => different commitment)', () => {
    const a = deployAndReadLedger();
    expect(organizerCommitment(SECRET, a.contractAddress)).not.toBe(
      organizerCommitment(SECRET, `${'11'.repeat(32)}`),
    );
  });

  it('is deterministic for the same key and address', () => {
    const { contractAddress } = deployAndReadLedger();
    expect(organizerCommitment(SECRET, contractAddress)).toBe(organizerCommitment(SECRET, contractAddress));
  });
});
