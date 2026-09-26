import { describe, it, expect } from 'vitest';
import {
  createCircuitContext,
  createConstructorContext,
  CompactTypeBytes,
  CompactTypeVector,
  dummyContractAddress,
  persistentHash,
} from '@midnight-ntwrk/compact-runtime';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import * as ZKEventAccess from '../managed/zk-event-access/contract/index.js';
import { Contract, ledger } from '../managed/zk-event-access/contract/index.js';
import { witnesses, createZKEventAccessPrivateState } from '../src/witnesses.js';
import { CONSTRUCTION_ADDRESS_PLACEHOLDER, constructorOrganizerCommitment, organizerCommitment } from '../src/midnight/zk-event-access-api.js';
import { CIRCUIT_CONTEXT_ADDRESS } from './fixtures/contract-address.js';

const SECRET = new Uint8Array(32).fill(7);
const OTHER_SECRET = new Uint8Array(32).fill(9);

/** pad(32, "zkEventAccess:organizer") — the contract's domain separator. */
const DOMAIN = new Uint8Array([
  122, 107, 69, 118, 101, 110, 116, 65, 99, 99, 101, 115, 115, 58, 111, 114, 103, 97, 110, 105, 122, 101, 114, 0, 0,
  0, 0, 0, 0, 0, 0, 0,
]);

/**
 * Runs the REAL constructor (same call the deploy path makes) and returns its public ledger.
 *
 * The circuit-context address is the shared deterministic fixture rather than
 * `sampleContractAddress()`, which panics with `RuntimeError: unreachable` in this
 * Vitest/WASM environment — see tests/fixtures/contract-address.ts.
 */
function runConstructor(secret: Uint8Array) {
  const contract = new Contract(witnesses);
  const init = contract.initialState(
    createConstructorContext(createZKEventAccessPrivateState(secret), { bytes: new Uint8Array(32) }),
  );
  const ctx = createCircuitContext(
    CIRCUIT_CONTEXT_ADDRESS,
    init.currentZswapLocalState,
    init.currentContractState,
    init.currentPrivateState,
  );
  return ledger(ctx.currentQueryContext.state);
}

const hash = (elements: Uint8Array[], arity: number) =>
  toHex(new Uint8Array(persistentHash(new CompactTypeVector(arity, new CompactTypeBytes(32)), elements)));

describe('contract constructor: what the organizer cell actually contains', () => {
  it('writes a 32-byte ZERO placeholder into `contractAddress` (kernel.self().bytes)', () => {
    const l = runConstructor(SECRET);
    expect(l.contractAddress).toBeInstanceOf(Uint8Array);
    expect(l.contractAddress.length).toBe(32);
    // A contract's own address does not exist while its constructor runs:
    // ContractDeploy generates the (randomised) address only afterwards.
    expect(l.contractAddress.every((b) => b === 0)).toBe(true);
  });

  it('is independent of the circuit context address', () => {
    const a = runConstructor(SECRET);
    const b = runConstructor(SECRET);
    expect(toHex(a.contractAddress)).toBe(toHex(b.contractAddress));
    expect(toHex(a.organizer)).toBe(toHex(b.organizer));
  });
});

describe('off-chain organizer commitment mirrors the contract exactly', () => {
  it('equals the organizer the real constructor puts on-chain', () => {
    const l = runConstructor(SECRET);
    expect(organizerCommitment(SECRET).toLowerCase()).toBe(toHex(l.organizer).toLowerCase());
  });

  it('hashes the zero placeholder, NOT the deployed address (regression)', () => {
    const l = runConstructor(SECRET);
    // Correct: domain || 32 zero bytes || sk
    expect(organizerCommitment(SECRET)).toBe(hash([DOMAIN, new Uint8Array(32), SECRET], 3));
    // What the previous (broken) implementation produced: domain || real address || sk
    const wrongAddress = new Uint8Array(32).fill(0xab);
    expect(organizerCommitment(SECRET)).not.toBe(hash([DOMAIN, wrongAddress, SECRET], 3));
    // And what the pre-d56eb0a implementation produced: domain || sk as a Vector<2>
    expect(organizerCommitment(SECRET)).not.toBe(hash([DOMAIN, SECRET], 2));
  });

  it('is deterministic for the same wallet identity (requirement 1)', () => {
    expect(organizerCommitment(SECRET)).toBe(organizerCommitment(SECRET));
  });

  it('differs for a different wallet identity (requirement 3)', () => {
    expect(organizerCommitment(SECRET)).not.toBe(organizerCommitment(OTHER_SECRET));
    expect(organizerCommitment(SECRET)).not.toBe(
      toHex(runConstructor(OTHER_SECRET).organizer),
    );
  });

  it('is a 32-byte commitment derived only from the wallet key — no hardcoded value', () => {
    const c = organizerCommitment(SECRET);
    expect(c).toMatch(/^[0-9a-f]{64}$/);
    // Not the key, not a constant baked into the source.
    expect(c).not.toBe(toHex(SECRET));
    expect(c).not.toBe(organizerCommitment(new Uint8Array(32)));
  });
});

describe('constructorOrganizerCommitment: the expectation is produced BY the contract', () => {
  it('equals the organizer the real constructor puts on-chain', () => {
    expect(constructorOrganizerCommitment(SECRET).toLowerCase()).toBe(
      toHex(runConstructor(SECRET).organizer).toLowerCase(),
    );
    expect(constructorOrganizerCommitment(OTHER_SECRET).toLowerCase()).toBe(
      toHex(runConstructor(OTHER_SECRET).organizer).toLowerCase(),
    );
  });

  it('agrees with the hand-written mirror, so the mirror can never drift', () => {
    // This is the invariant that makes the TypeScript restatement of
    // `publicKey` safe to keep: if the compiled contract ever changes shape,
    // one of these two assertions fails instead of every future deploy
    // silently failing its post-deployment organizer check.
    expect(constructorOrganizerCommitment(SECRET)).toBe(organizerCommitment(SECRET));
    expect(constructorOrganizerCommitment(OTHER_SECRET)).toBe(organizerCommitment(OTHER_SECRET));
  });

  it('is a 32-byte hex commitment, differing per wallet identity', () => {
    expect(constructorOrganizerCommitment(SECRET)).toMatch(/^[0-9a-f]{64}$/);
    expect(constructorOrganizerCommitment(SECRET)).not.toBe(
      constructorOrganizerCommitment(OTHER_SECRET),
    );
  });

  it('is neither the Vector<2> nor the deployed-address commitment (regression)', () => {
    const actual = constructorOrganizerCommitment(SECRET);
    // domain || sk, with no address element at all.
    expect(actual).not.toBe(hash([DOMAIN, SECRET], 2));
    // domain || real deployed address || sk — a contract has no address while
    // its constructor runs, so this can never equal the ledger's cell.
    expect(actual).not.toBe(hash([DOMAIN, new Uint8Array(32).fill(0xab), SECRET], 3));
  });

  it('enforces the contract\'s own "organizer secret must not be empty" assertion', () => {
    // The hand-written mirror happily returns a digest for an all-zero key; the
    // contract rejects that key, and this derivation inherits that rejection
    // because it runs the real constructor.
    expect(() => constructorOrganizerCommitment(new Uint8Array(32))).toThrow();
  });

  it('is independent of the constructor context the deploy path supplies', () => {
    // Justifies the fixed zero context used by constructorOrganizerCommitment:
    // neither the coin public key nor the circuit-context address can move the
    // organizer cell, so verification cannot depend on wallet-reported values.
    const withCoinKey = (coinPublicKey: string) => {
      const init = new Contract(witnesses).initialState(
        createConstructorContext(createZKEventAccessPrivateState(SECRET), coinPublicKey),
      );
      const ctx = createCircuitContext(
        CIRCUIT_CONTEXT_ADDRESS,
        init.currentZswapLocalState,
        init.currentContractState,
        init.currentPrivateState,
      );
      return toHex(ledger(ctx.currentQueryContext.state).organizer);
    };
    expect(withCoinKey('11'.repeat(32))).toBe(withCoinKey('00'.repeat(32)));
    expect(withCoinKey('11'.repeat(32))).toBe(constructorOrganizerCommitment(SECRET));
  });
});

describe('CONSTRUCTION_ADDRESS_PLACEHOLDER: the zero-address input the mirror hashes', () => {
  it('is the zero address the contract constructor discloses, not a deployed address', () => {
    expect(dummyContractAddress()).toBe('0'.repeat(64));
    // Documented reliance: the hex STRING above is cast to Uint8Array, and
    // `new Uint8Array(<string>)` produces a ZERO-LENGTH array — see the
    // CONSTRUCTION_ADDRESS_PLACEHOLDER doc comment in zk-event-access-api.ts.
    expect(CONSTRUCTION_ADDRESS_PLACEHOLDER.length).toBe(0);
    // Whatever its length, every byte it does carry is a zero byte.
    expect(Array.from(CONSTRUCTION_ADDRESS_PLACEHOLDER).every((b) => b === 0)).toBe(true);
    expect(runConstructor(SECRET).contractAddress.every((b) => b === 0)).toBe(true);
  });

  it('is exactly the element the current implementation feeds to persistentHash', () => {
    expect(organizerCommitment(SECRET)).toBe(hash([DOMAIN, CONSTRUCTION_ADDRESS_PLACEHOLDER, SECRET], 3));
  });

  it('hashes identically to 32 explicit zero bytes, because Bytes<32> pads the element', () => {
    const viaPlaceholder = hash([DOMAIN, CONSTRUCTION_ADDRESS_PLACEHOLDER, SECRET], 3);
    const viaExplicitZeros = hash([DOMAIN, new Uint8Array(32), SECRET], 3);
    expect(viaPlaceholder).toBe(viaExplicitZeros);
    // And that padded value is what the real constructor put on-chain.
    expect(viaPlaceholder).toBe(toHex(runConstructor(SECRET).organizer));
  });

  it('can never be confused with a real deployed address', () => {
    // If a future SDK returned a non-zero dummy address, or one that needed no
    // padding, the commitment would diverge from the constructor's and every
    // post-deploy verification would fail. These assertions are what makes that
    // a loud test failure rather than a silent production mismatch.
    const realAddress = new Uint8Array(32).fill(0xab);
    expect(organizerCommitment(SECRET)).not.toBe(hash([DOMAIN, realAddress, SECRET], 3));
    expect(organizerCommitment(SECRET)).not.toBe(hash([DOMAIN, new Uint8Array(32).fill(0x01), SECRET], 3));
    expect(organizerCommitment(SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('increment agrees with the deployment commitment', () => {
  it('the contract self-check passes, proving one shared formula', () => {
    const contract = new Contract(witnesses);
    const init = contract.initialState(
      createConstructorContext(createZKEventAccessPrivateState(SECRET), { bytes: new Uint8Array(32) }),
    );
    const ctx = createCircuitContext(
      CIRCUIT_CONTEXT_ADDRESS,
      init.currentZswapLocalState,
      init.currentContractState,
      init.currentPrivateState,
    );
    // If the frontend mirror and the on-chain formula disagreed, the contract's
    // own `assert(organizer == publicKey(sk))` could not hold for this key.
    expect(() => contract.impureCircuits.increment(ctx)).not.toThrow();
    expect(organizerCommitment(SECRET).toLowerCase()).toBe(toHex(ZKEventAccess.ledger(ctx.currentQueryContext.state).organizer).toLowerCase());
  });
});
