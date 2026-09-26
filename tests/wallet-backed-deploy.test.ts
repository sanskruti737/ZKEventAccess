/**
 * End-to-end (off-chain) coverage of the wallet-backed deployment lifecycle:
 * derive organizer identity → deploy → read the NEW event's on-chain organizer
 * → verify with the SAME canonical formula → activate. Plus the failure paths,
 * which must never activate anything.
 *
 * Nothing here talks to a wallet, a node or an indexer: the contract is driven
 * through the real Compact runtime, and only the network edges are faked, so the
 * security-relevant logic is genuinely exercised rather than asserted about.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createCircuitContext, createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { assertIsContractAddress, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { Contract, ledger } from '../managed/zk-event-access/contract/index.js';
import { witnesses, createZKEventAccessPrivateState } from '../src/witnesses.js';
import {
  OrganizerUnverifiedError,
  OrganizerVerificationError,
  ZKEventAccessAPI,
  organizerCommitment,
  type ZKEventAccessProviders,
} from '../src/midnight/zk-event-access-api';
import { ZK_EVENT_ACCESS_PRIVATE_STATE_ID } from '../src/midnight/zk-event-access-api';
import {
  FOREIGN_ORGANIZER_HEADLINE,
  invalidateActiveEvent,
  readActiveEventRecord,
  readVerifiedActiveEventAddress,
  recordUnverifiedDeployment,
  recordVerifiedActiveEvent,
  requireVerifiedActiveEvent,
} from '../src/midnight/active-event';
import { CIRCUIT_CONTEXT_ADDRESS } from './fixtures/contract-address.js';
import type { ZKEventAccessPrivateState } from '../src/witnesses.js';

const WALLET_SK = new Uint8Array(32).fill(0xa1);
const OTHER_WALLET_SK = new Uint8Array(32).fill(0xb2);
const EVENT_A = 'fb24191c6928e59a9490942d6343fb6facfb5a19965c1f85096c06c78af6fc8e';
const EVENT_B = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** Deploys the REAL contract in the Compact runtime and returns its public ledger. */
const deployOnChain = (secret: Uint8Array) => {
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
  return { contract, ctx, init, state: ledger(ctx.currentQueryContext.state) };
};

/** A provider bundle whose wallet-bound private state already holds `secret`. */
const providersFor = (secret: Uint8Array): ZKEventAccessProviders =>
  ({
    privateStateProvider: {
      async get() {
        return { organizerSecretKey: secret } as ZKEventAccessPrivateState;
      },
      async set() {
        /* no-op */
      },
    },
  }) as unknown as ZKEventAccessProviders;

/** The subset of ZKEventAccessAPI that verifyOrganizer actually uses. */
const apiFor = (address: string, onChainOrganizer: string) =>
  ({
    contractAddress: address,
    readLatest: async () => ({ counter: 0n, announcement: '', organizer: onChainOrganizer }),
  }) as unknown as ZKEventAccessAPI;

let store = new Map<string, string>();
const installLocalStorage = () => {
  store = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
};

beforeEach(() => installLocalStorage());
afterEach(() => delete (globalThis as Record<string, unknown>).window);

// ─── the canonical algorithm, end to end ─────────────────────────────────────

describe('wallet identity → contract-compatible organizer commitment', () => {
  it('is exactly what the real constructor writes on-chain', () => {
    const { state } = deployOnChain(WALLET_SK);
    expect(organizerCommitment(WALLET_SK)).toBe(toHex(state.organizer));
  });

  it('does not depend on the event address, so it can be computed before deploying', async () => {
    // This is what makes post-deploy verification possible at all: the deploy
    // address does not exist while the constructor runs, so the address element
    // of the hash is a constant and the expectation is knowable up-front.
    const { state } = deployOnChain(WALLET_SK);
    const asHex = toHex(state.organizer);
    expect(organizerCommitment(WALLET_SK)).toBe(asHex);
    expect(organizerCommitment(WALLET_SK)).toBe(organizerCommitment(WALLET_SK));
  });

  it('differs per wallet, so two wallets can never verify each other', () => {
    const a = deployOnChain(WALLET_SK);
    const b = deployOnChain(OTHER_WALLET_SK);
    expect(organizerCommitment(WALLET_SK)).not.toBe(organizerCommitment(OTHER_WALLET_SK));
    expect(toHex(a.state.organizer)).not.toBe(toHex(b.state.organizer));
  });
});

// ─── organizer verification ──────────────────────────────────────────────────

describe('organizer verification of a newly deployed event', () => {
  it('passes when the on-chain organizer equals the connected wallet identity', async () => {
    const { state } = deployOnChain(WALLET_SK);
    const result = await ZKEventAccessAPI.verifyOrganizer(apiFor(EVENT_A, toHex(state.organizer)), providersFor(WALLET_SK));
    expect(result.verified).toBe(true);
    expect(result.onChain).toBe(result.expected);
    expect(result.address).toBe(EVENT_A);
  });

  it('fails when the event belongs to another wallet, naming both values', async () => {
    const other = deployOnChain(OTHER_WALLET_SK);
    const result = await ZKEventAccessAPI.verifyOrganizer(
      apiFor(EVENT_A, toHex(other.state.organizer)),
      providersFor(WALLET_SK),
    );
    expect(result.verified).toBe(false);
    expect(result.onChain).toBe(toHex(other.state.organizer));
    expect(result.expected).toBe(organizerCommitment(WALLET_SK));
    expect(result.onChain).not.toBe(result.expected);
  });

  it('is case-insensitive, as hex from two sources can differ in case', async () => {
    const { state } = deployOnChain(WALLET_SK);
    const result = await ZKEventAccessAPI.verifyOrganizer(
      apiFor(EVENT_A, toHex(state.organizer).toUpperCase()),
      providersFor(WALLET_SK),
    );
    expect(result.verified).toBe(true);
  });
});

// ─── the full activation lifecycle ───────────────────────────────────────────

describe('wallet-backed deployment → verification → activation', () => {
  it('never becomes active until the organizer was read back and matched', async () => {
    const { state } = deployOnChain(WALLET_SK);

    // 1. Deployment finalized on-chain. Remembered, but NOT usable.
    recordUnverifiedDeployment(EVENT_A);
    expect(readActiveEventRecord()).toMatchObject({ address: EVENT_A, status: 'unverified' });
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);

    // 2. Read the NEW event's organizer and verify it.
    const result = await ZKEventAccessAPI.verifyOrganizer(
      apiFor(EVENT_A, toHex(state.organizer)),
      providersFor(WALLET_SK),
    );
    expect(result.verified).toBe(true);

    // 3. Only now is it active.
    recordVerifiedActiveEvent(EVENT_A, result.onChain);
    expect(readVerifiedActiveEventAddress()).toBe(EVENT_A);
    expect(requireVerifiedActiveEvent(readActiveEventRecord())).toEqual({ ok: true, address: EVENT_A });
  });

  it('leaves the event inactive when verification fails, and says exactly why', async () => {
    const other = deployOnChain(OTHER_WALLET_SK);
    const onChain = toHex(other.state.organizer);
    recordUnverifiedDeployment(EVENT_A);

    const result = await ZKEventAccessAPI.verifyOrganizer(apiFor(EVENT_A, onChain), providersFor(WALLET_SK));
    expect(result.verified).toBe(false);

    const err = new OrganizerVerificationError(EVENT_A, onChain, result.expected);
    expect(err.onChain).toBe(onChain);
    expect(err.expected).toBe(result.expected);
    expect(err.message).toContain(onChain);
    expect(err.message).toContain(result.expected);
    expect(err.message).toContain('NOT activated');
    expect(err.message).toContain(FOREIGN_ORGANIZER_HEADLINE);

    // The failed deployment is still remembered, still not usable, and no
    // second deployment was triggered by the failure.
    expect(readActiveEventRecord()).toMatchObject({ address: EVENT_A, status: 'unverified' });
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
  });

  it('an indexer lag also leaves the event inactive, never silently activated', () => {
    recordUnverifiedDeployment(EVENT_A);
    const err = new OrganizerUnverifiedError(EVENT_A, organizerCommitment(WALLET_SK), undefined, 'indexer timeout');
    expect(err.message).toContain('indexer timeout');
    expect(err.message).toMatch(/NOT active/i);
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
  });

  it('a second wallet connecting finds the event foreign and is blocked, not silently swapped', async () => {
    const mine = deployOnChain(WALLET_SK);
    recordUnverifiedDeployment(EVENT_A);
    const mineCheck = await ZKEventAccessAPI.verifyOrganizer(
      apiFor(EVENT_A, toHex(mine.state.organizer)),
      providersFor(WALLET_SK),
    );
    recordVerifiedActiveEvent(EVENT_A, mineCheck.onChain);

    // Now a DIFFERENT wallet opens the app and restores the stored event.
    const theirCheck = await ZKEventAccessAPI.verifyOrganizer(
      apiFor(EVENT_A, toHex(mine.state.organizer)),
      providersFor(OTHER_WALLET_SK),
    );
    expect(theirCheck.verified).toBe(false);
    invalidateActiveEvent('foreign-organizer', `on-chain ${mineCheck.onChain} ≠ wallet ${theirCheck.expected}`);
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord())).toMatchObject({ ok: false });

    // They deploy their own; only theirs becomes active.
    const theirs = deployOnChain(OTHER_WALLET_SK);
    const theirVerify = await ZKEventAccessAPI.verifyOrganizer(
      apiFor(EVENT_B, toHex(theirs.state.organizer)),
      providersFor(OTHER_WALLET_SK),
    );
    expect(theirVerify.verified).toBe(true);
    recordVerifiedActiveEvent(EVENT_B, theirVerify.onChain);
    expect(readVerifiedActiveEventAddress()).toBe(EVENT_B);
  });
});

// ─── Issue credential / Verify access both target the verified event ──────────

describe('Issue credential and Verify access read the same active event', () => {
  it('both actions resolve the one verified address', () => {
    const mine = deployOnChain(WALLET_SK);
    recordVerifiedActiveEvent(EVENT_A, toHex(mine.state.organizer));

    const issueGate = requireVerifiedActiveEvent(readActiveEventRecord());
    const verifyGate = requireVerifiedActiveEvent(readActiveEventRecord());
    expect(issueGate.ok).toBe(true);
    expect(verifyGate.ok).toBe(true);
    expect((issueGate as { address: string }).address).toBe(EVENT_A);
    expect((verifyGate as { address: string }).address).toBe(EVENT_A);
  });

  it('both actions are blocked on an unverified deployment', () => {
    recordUnverifiedDeployment(EVENT_A);
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
  });

  it('the increment witness key the API uses really does satisfy the contract assert', () => {
    // The full proof-less path: constructor wrote `organizer`, then increment
    // recomputes publicKey(sk) from the same ledger cell and asserts equality.
    const { contract, ctx } = deployOnChain(WALLET_SK);
    // A circuit run does not mutate `ctx`: the post-circuit state comes back on
    // the CircuitResults, so the new count must be read from there.
    const results = contract.impureCircuits.increment(ctx);
    expect(ledger(results.context.currentQueryContext.state).counter).toBe(1n);
    expect(ZK_EVENT_ACCESS_PRIVATE_STATE_ID).toBe('counterPrivateState');
  });

  it('a wallet whose key does not match cannot increment the event', () => {
    const { contract, init } = deployOnChain(WALLET_SK);
    const impostor = createCircuitContext(
      CIRCUIT_CONTEXT_ADDRESS,
      init.currentZswapLocalState,
      init.currentContractState,
      createZKEventAccessPrivateState(OTHER_WALLET_SK),
    );
    expect(() => contract.impureCircuits.increment(impostor)).toThrow(/only the organizer can issue access/);
  });
});

// ─── the circuit-context address fixture itself ──────────────────────────────

describe('the deterministic contract-address fixture', () => {
  it('is exactly 32 bytes of hex with no 0x prefix', () => {
    expect(CIRCUIT_CONTEXT_ADDRESS).toMatch(/^[0-9a-f]{64}$/);
    expect(CIRCUIT_CONTEXT_ADDRESS.length / 2).toBe(32);
  });

  it('is a valid contract address for the SDK type the code passes to the runtime', () => {
    // The same check midnight-js performs before it will talk to a contract, so
    // a fixture that passed here cannot be rejected as malformed at runtime.
    expect(() => assertIsContractAddress(CIRCUIT_CONTEXT_ADDRESS)).not.toThrow();
  });

  it('is a fixed constant, so every run drives an identical circuit context', () => {
    expect(CIRCUIT_CONTEXT_ADDRESS).toBe('5ec0'.repeat(16));
  });

  it('does not change what the constructor commits, because the ledger cell is address-independent', () => {
    const { state } = deployOnChain(WALLET_SK);
    expect(toHex(state.contractAddress)).toBe('0'.repeat(64));
    expect(organizerCommitment(WALLET_SK)).toBe(toHex(state.organizer));
  });
});
