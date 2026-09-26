/**
 * End-to-end regression coverage of the wallet-backed event flow, driving the
 * REAL modules and only faking the network edges (the 1AM wallet, the indexer
 * and `localStorage`).
 *
 * The chain is not simulated: the deployed event's public `organizer` cell is
 * produced by executing the compiled Compact constructor with the very key the
 * deploy was built from, so "the on-chain organizer equals the connected
 * wallet's identity" is genuinely computed, never asserted about. That is what
 * makes these tests able to catch the defect they exist for: a deployment that
 * finalized, was verified, and was then lost before Issue/Verify could see it.
 *
 * Covered, in the order the flow actually runs:
 *
 *   1.  no active event before deployment
 *   2.  a successful wallet-backed deployment creates an active event
 *   3.  the address the deployment returned is the one persisted
 *   4.  that address is read back correctly
 *   5.  organizer verification must pass BEFORE activation
 *   6.  Issue credential uses the active verified address
 *   7.  Verify access uses the active verified address
 *   8.  a stale/old event address is never silently reused
 *
 * plus the storage-failure regressions: a browser that refuses the write must
 * not lose a verified event, must not destroy the address it was superseding,
 * and must be reported instead of being declared a successful configuration.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCircuitContext, createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { of } from 'rxjs';
import { Contract } from '../managed/zk-event-access/contract/index.js';
import { witnesses, createZKEventAccessPrivateState, type ZKEventAccessPrivateState } from '../src/witnesses.js';
import { CIRCUIT_CONTEXT_ADDRESS } from './fixtures/contract-address.js';

const { deployContractMock, findDeployedContractMock } = vi.hoisted(() => ({
  deployContractMock: vi.fn(),
  findDeployedContractMock: vi.fn(),
}));

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({
  deployContract: deployContractMock,
  findDeployedContract: findDeployedContractMock,
}));

import {
  OrganizerIdentityUnavailableError,
  ZKEventAccessAPI,
  ZK_EVENT_ACCESS_PRIVATE_STATE_ID,
  type ZKEventAccessProviders,
} from '../src/midnight/zk-event-access-api';
import {
  ACTIVE_EVENT_KEY,
  activeEventNotPersistedMessage,
  forgetActiveEvent,
  invalidateActiveEvent,
  isActiveEventDurable,
  readActiveEventRecord,
  readStoredActiveEventOrganizer,
  readVerifiedActiveEventAddress,
  recordUnverifiedDeployment,
  recordVerifiedActiveEvent,
  requireVerifiedActiveEvent,
} from '../src/midnight/active-event';

const ORGANIZER_A = new Uint8Array(32).fill(0xa1);
const ORGANIZER_B = new Uint8Array(32).fill(0xb2);
const EVENT_A = 'fb24191c6928e59a9490942d6343fb6facfb5a19965c1f85096c06c78af6fc8e';
const EVENT_B = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * Executes the REAL compiled constructor with `secret` and returns the real
 * post-constructor contract state — i.e. what a node would have written.
 */
const chainStateFor = (secret: Uint8Array) => {
  const contract = new Contract(witnesses);
  const init = contract.initialState(
    createConstructorContext(createZKEventAccessPrivateState(secret), { bytes: new Uint8Array(32) }),
  );
  return createCircuitContext(
    CIRCUIT_CONTEXT_ADDRESS,
    init.currentZswapLocalState,
    init.currentContractState,
    init.currentPrivateState,
  ).currentQueryContext.state;
};

// ─── fakes for the three network edges ───────────────────────────────────────

/** The 1AM wallet's `signData` is NON-DETERMINISTIC: every call is a new key. */
let walletSignatureCount = 0;
const nextWalletKey = (): Uint8Array => new Uint8Array(32).fill(++walletSignatureCount);

type StorageMode = 'normal' | 'refuses-writes' | 'blocked';
let store = new Map<string, string>();
let storageMode: StorageMode = 'normal';

const installWindow = (): void => {
  store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (storageMode === 'refuses-writes') throw new DOMException('quota', 'QuotaExceededError');
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as Record<string, unknown>).window =
    storageMode === 'blocked' ? {} : { localStorage };
};

/** The wallet's private state, as IndexedDB would hold it. */
let privateState: ZKEventAccessPrivateState | null = null;
/** What the SDK is asked to write, so a destructive write can be detected. */
const privateStateWrites: Array<ZKEventAccessPrivateState | null> = [];

/** The key the fake chain records the organizer for, i.e. what a node stored. */
let chainOrganizerKey: Uint8Array | null = null;
/** Forces a foreign organizer on-chain, to exercise the mismatch path. */
let chainOrganizerOverride: Uint8Array | null = null;

const chainState = () => {
  const key = chainOrganizerOverride ?? chainOrganizerKey;
  if (!key) throw new Error('no deployment has been accepted by the fake chain yet');
  return chainStateFor(key);
};

const harness = (): ZKEventAccessProviders =>
  ({
    privateStateProvider: {
      async get() {
        return privateState;
      },
      async set(_key: string, state: ZKEventAccessPrivateState) {
        privateState = state;
        privateStateWrites.push(state);
      },
      setContractAddress() {},
    },
    organizerIdentity: { deriveOrganizerSecretKey: async () => nextWalletKey() },
    publicDataProvider: {
      contractStateObservable: () => of({ data: chainState() }),
      queryContractState: async () => ({ data: chainState() }),
    },
  }) as unknown as ZKEventAccessProviders;

beforeEach(() => {
  storageMode = 'normal';
  installWindow();
  privateState = null;
  privateStateWrites.length = 0;
  walletSignatureCount = 0;
  chainOrganizerKey = null;
  chainOrganizerOverride = null;
  forgetActiveEvent();
  deployContractMock.mockReset();
  findDeployedContractMock.mockReset();
});

afterEach(() => delete (globalThis as Record<string, unknown>).window);

/**
 * Makes the next deployment finalize at `address`, writing the private state the
 * way the real SDK does (deployContract stores `initialPrivateState`) and
 * committing the organizer of the key it was handed — which is exactly what a
 * node does, so the on-chain value under test is never assumed.
 */
const chainAcceptsDeploymentAt = (address: string): void => {
  deployContractMock.mockImplementation(async (providers: ZKEventAccessProviders, options: any) => {
    await providers.privateStateProvider.set(options.privateStateId, options.initialPrivateState);
    chainOrganizerKey = options.initialPrivateState.organizerSecretKey;
    return {
      deployTxData: { public: { contractAddress: address, txHash: '0x1' } },
      callTx: { increment: async () => undefined, read: async () => undefined },
    };
  });
};

// ─── 1. no active event before deployment ────────────────────────────────────

describe('1. before any deployment there is no active event', () => {
  it('exposes no address and blocks both ledger actions with the deploy action named', () => {
    expect(readActiveEventRecord()).toBeUndefined();
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(isActiveEventDurable()).toBe(false);

    const gate = requireVerifiedActiveEvent(readActiveEventRecord());
    expect(gate.ok).toBe(false);
    expect(gate).toMatchObject({
      message: expect.stringContaining('No event contract address configured'),
    });
    expect(gate).toMatchObject({
      message: expect.stringContaining('Deploy a new wallet-backed event'),
    });
  });

  it('does not require an existing event to deploy one: the flow runs from empty', async () => {
    // Nothing is stored, so nothing may stand in the way of the first deployment.
    expect(readActiveEventRecord()).toBeUndefined();
    chainAcceptsDeploymentAt(EVENT_A);

    const result = await ZKEventAccessAPI.deployNew(harness());

    expect(String(result.api.contractAddress)).toBe(EVENT_A);
    expect(result.organizerCommitment).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── 2–4. deploy → verify → activate → read back ────────────────────────────

/**
 * The exact sequence src/components/CircuitCall.tsx performs after a deployment:
 * record the finalized address as unverified, read the organizer back from the
 * indexer, compare it against the commitment the deployment was built from, and
 * only then record the event as the verified active one.
 */
const deployVerifyAndActivate = async () => {
  const providers = harness();
  const finalized: string[] = [];
  const { api, organizerCommitment: expectedOrganizer } = await ZKEventAccessAPI.deployNew(
    providers,
    undefined,
    (address) => {
      finalized.push(address);
      recordUnverifiedDeployment(address);
    },
  );
  const deployedAddress = String(api.contractAddress);
  const onChainState = await api.readLatest();
  if (expectedOrganizer.toLowerCase() !== onChainState.organizer.toLowerCase()) {
    throw new Error('organizer mismatch');
  }
  recordVerifiedActiveEvent(deployedAddress, onChainState.organizer);
  return { providers, api, deployedAddress, onChainState, finalized, expectedOrganizer };
};

describe('2. a successful wallet-backed deployment creates an active event', () => {
  it('publishes the finalized address first, unverified, then verified — and only then', async () => {
    chainAcceptsDeploymentAt(EVENT_A);
    const { deployedAddress, onChainState, finalized, expectedOrganizer } = await deployVerifyAndActivate();

    expect(finalized).toEqual([deployedAddress]);
    expect(deployedAddress).toBe(EVENT_A);
    // The commitment really is the one the chain recorded for this wallet: the
    // fake chain ran the compiled constructor with the very key the deploy was
    // built from, so this compares two independently produced values.
    expect(expectedOrganizer.toLowerCase()).toBe(onChainState.organizer.toLowerCase());
    expect(walletSignatureCount).toBe(1);
    expect(readVerifiedActiveEventAddress()).toBe(EVENT_A);
  });

  it('never marks the event usable before the organizer has been read back', () => {
    recordUnverifiedDeployment(EVENT_A);
    expect(readActiveEventRecord()).toMatchObject({ address: EVENT_A, status: 'unverified' });
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(readStoredActiveEventOrganizer()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
  });
});

describe('3. the address the deployment returned is the address persisted', () => {
  it('persists exactly the address deployContract finalized at, not some other one', async () => {
    chainAcceptsDeploymentAt(EVENT_A);
    const { deployedAddress } = await deployVerifyAndActivate();

    const record = readActiveEventRecord();
    expect(record?.address).toBe(deployedAddress);
    expect(record?.status).toBe('verified');
    expect(record?.organizer).toBe(readStoredActiveEventOrganizer());
    expect(JSON.parse(store.get('zkEventAccess.activeEvent.v1')!).address).toBe(deployedAddress);
  });

  it('refuses to persist anything that is not a real address + 32-byte commitment', () => {
    recordVerifiedActiveEvent('not-an-address', readStoredActiveEventOrganizer() ?? 'a'.repeat(64));
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
  });
});

describe('4. the persisted address is read back correctly', () => {
  it('is restored by a fresh reader, as after a page reload', async () => {
    chainAcceptsDeploymentAt(EVENT_A);
    const { deployedAddress } = await deployVerifyAndActivate();

    // A reload knows the event only through storage.
    expect(isActiveEventDurable()).toBe(true);
    expect(readActiveEventRecord()).toMatchObject({
      address: deployedAddress,
      status: 'verified',
    });
    expect(requireVerifiedActiveEvent(readActiveEventRecord())).toEqual({ ok: true, address: deployedAddress });
  });
});

// ─── 5. verification must pass before activation ─────────────────────────────

describe('5. organizer verification must pass before activation', () => {
  it('leaves a deployment on a foreign organizer inactive, and activates nothing', async () => {
    // The chain holds ORGANIZER_B's commitment; this wallet's identity is A.
    chainAcceptsDeploymentAt(EVENT_A);
    const providers = harness();
    chainOrganizerOverride = ORGANIZER_B; // the chain recorded a different organizer

    const finalized: string[] = [];
    await expect(
      ZKEventAccessAPI.deployNew(providers, undefined, (address) => {
        finalized.push(address);
        recordUnverifiedDeployment(address);
      }),
    ).rejects.toThrow(/does not match the connected 1AM wallet/);

    // The address is remembered so the event is not orphaned, but never usable.
    expect(finalized).toEqual([EVENT_A]);
    expect(readActiveEventRecord()).toMatchObject({ address: EVENT_A, status: 'unverified' });
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
  });

  it('refuses to record a verified event without a matched commitment', () => {
    recordUnverifiedDeployment(EVENT_A);
    recordVerifiedActiveEvent(EVENT_A, 'too-short');
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
  });
});

// ─── 6–7. Issue credential and Verify access both use the active event ───────

describe('6. Issue credential uses the active verified address', () => {
  it('joins and acts on the address that was deployed and verified', async () => {
    chainAcceptsDeploymentAt(EVENT_A);
    const { providers, deployedAddress } = await deployVerifyAndActivate();

    const gate = requireVerifiedActiveEvent(readActiveEventRecord());
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error('gate must pass');

    findDeployedContractMock.mockImplementation(async (_p: ZKEventAccessProviders, options: any) => {
      // The SDK's non-destructive join reads the stored state; it must never be
      // handed an `initialPrivateState`, which would be WRITTEN over the key.
      expect(Object.prototype.hasOwnProperty.call(options, 'initialPrivateState')).toBe(false);
      return {
        deployTxData: { public: { contractAddress: options.contractAddress, txHash: '0x1' } },
        callTx: { increment: vi.fn(async () => undefined), read: vi.fn(async () => undefined) },
      };
    });

    const joined = await ZKEventAccessAPI.join(providers, gate.address as never);
    expect(String(joined.contractAddress)).toBe(deployedAddress);

    await joined.increment();
    // The organizer pre-flight uses the same identity the deployment verified.
    const [expectedOrganizer, onChain] = await Promise.all([
      ZKEventAccessAPI.currentOrganizerCommitment(providers),
      joined.readLatest(),
    ]);
    expect(expectedOrganizer.toLowerCase()).toBe(onChain.organizer.toLowerCase());
    expect(walletSignatureCount).toBe(1); // one identity for the whole session
  });
});

describe('7. Verify access uses the active verified address', () => {
  it('resolves the identical address Issue does, never a different event', async () => {
    chainAcceptsDeploymentAt(EVENT_A);
    await deployVerifyAndActivate();

    const issueGate = requireVerifiedActiveEvent(readActiveEventRecord());
    const verifyGate = requireVerifiedActiveEvent(readActiveEventRecord());
    expect(issueGate).toEqual(verifyGate);
    expect(issueGate.ok && issueGate.address).toBe(EVENT_A);
    expect(verifyGate.ok && verifyGate.address).toBe(EVENT_A);
  });

  it('cannot act on an event this browser has not verified', () => {
    recordUnverifiedDeployment(EVENT_A);
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
  });
});

// ─── 8. a stale/old event address is never silently reused ───────────────────

describe('8. a stale event address is never silently reused', () => {
  it('a newer deployment fully replaces an older verified one', async () => {
    chainAcceptsDeploymentAt(EVENT_A);
    await deployVerifyAndActivate();
    expect(readVerifiedActiveEventAddress()).toBe(EVENT_A);

    chainAcceptsDeploymentAt(EVENT_B);
    await deployVerifyAndActivate();
    expect(readVerifiedActiveEventAddress()).toBe(EVENT_B);
    expect(readActiveEventRecord()?.address).toBe(EVENT_B);
  });

  it('an invalidated event is not revived by anything, including the in-session record', async () => {
    recordVerifiedActiveEvent(EVENT_A, 'a'.repeat(64));
    invalidateActiveEvent('foreign-organizer', `on-chain ${ORGANIZER_B} ≠ wallet ${ORGANIZER_A}`);
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(readActiveEventRecord()?.address).toBe(EVENT_A);
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
  });

  it('forgetActiveEvent drops the event entirely, in storage and in session', () => {
    recordVerifiedActiveEvent(EVENT_A, 'a'.repeat(64));
    expect(readVerifiedActiveEventAddress()).toBe(EVENT_A);
    forgetActiveEvent();
    expect(readActiveEventRecord()).toBeUndefined();
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord())).toMatchObject({ ok: false });
  });
});

// ─── the root cause: storage that refuses the activation write ──────────────

describe('a browser that refuses the write does not lose the event it just deployed', () => {
  it('keeps the verified event usable instead of reporting "no event configured"', async () => {
    chainAcceptsDeploymentAt(EVENT_A);
    installWindow();
    storageMode = 'refuses-writes';

    const { deployedAddress } = await deployVerifyAndActivate();

    // Nothing reached storage…
    expect(store.get('zkEventAccess.activeEvent.v1')).toBeUndefined();
    // …but the event is real, verified, and still the active event for this page.
    expect(readActiveEventRecord()).toMatchObject({ address: deployedAddress, status: 'verified' });
    expect(readVerifiedActiveEventAddress()).toBe(EVENT_A);
    expect(requireVerifiedActiveEvent(readActiveEventRecord())).toEqual({ ok: true, address: EVENT_A });
    // And the UI is told the truth about durability.
    expect(isActiveEventDurable()).toBe(false);
    expect(activeEventNotPersistedMessage(EVENT_A)).toContain('on-chain');
    expect(activeEventNotPersistedMessage(EVENT_A)).toMatch(/will be forgotten on refresh/i);
  });

  it('never deletes the address it was superseding when the superseding write is refused', () => {
    installWindow();
    recordVerifiedActiveEvent(EVENT_A, 'a'.repeat(64));
    const before = store.get(ACTIVE_EVENT_KEY);
    expect(readVerifiedActiveEventAddress()).toBe(EVENT_A);

    // A later write is refused. The pre-existing record must survive untouched.
    storageMode = 'refuses-writes';
    recordUnverifiedDeployment(EVENT_B);
    recordVerifiedActiveEvent(EVENT_B, 'b'.repeat(64));

    // STORAGE-LEVEL invariant: the refused writes left the only persisted copy
    // of the real, owned, verified event byte-for-byte intact — not deleted, not
    // truncated, not replaced by the event the browser could not record.
    expect(store.get(ACTIVE_EVENT_KEY)).toBe(before);
    expect(JSON.parse(before!)).toMatchObject({ address: EVENT_A, status: 'verified' });
    expect(store.size).toBe(1);
    // And the runtime serves that same previous event to both ledger actions.
    expect(readVerifiedActiveEventAddress()).toBe(EVENT_A);
    expect(readActiveEventRecord()?.address).toBe(EVENT_A);
  });

  it('keeps a rejected event unusable even when the rejection cannot be stored', () => {
    installWindow();
    recordVerifiedActiveEvent(EVENT_A, 'a'.repeat(64));
    expect(readVerifiedActiveEventAddress()).toBe(EVENT_A);

    // The organizer check comes back "not this wallet", and the write that would
    // record that verdict is refused.
    storageMode = 'refuses-writes';
    invalidateActiveEvent('foreign-organizer', `on-chain ${ORGANIZER_B} ≠ wallet ${ORGANIZER_A}`);

    // Storage is stuck saying `verified`, so the refusal must not be a licence
    // to keep issuing credentials against an event this wallet does not own.
    expect(JSON.parse(store.get(ACTIVE_EVENT_KEY)!)).toMatchObject({ status: 'verified' });
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
  });

  it('still blocks both actions when storage is entirely unavailable and nothing was deployed', () => {
    storageMode = 'blocked';
    installWindow();
    expect(readActiveEventRecord()).toBeUndefined();
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord())).toMatchObject({ ok: false });
  });
});

// ─── a join must never destroy the organizer key ────────────────────────────

describe('joining the active event cannot destroy the wallet organizer key', () => {
  it('does not write a zero placeholder over the persisted key', async () => {
    chainAcceptsDeploymentAt(EVENT_A);
    const { providers, deployedAddress } = await deployVerifyAndActivate();
    const persistedKey = chainOrganizerKey!;
    expect(privateState?.organizerSecretKey).toEqual(persistedKey);
    privateStateWrites.length = 0;

    findDeployedContractMock.mockImplementation(async () => ({
      deployTxData: { public: { contractAddress: deployedAddress, txHash: '0x1' } },
      callTx: { increment: vi.fn(), read: vi.fn() },
    }));

    await ZKEventAccessAPI.join(providers, deployedAddress as never);

    // The key is unrecoverable (signData is non-deterministic), so a join that
    // cannot read it must report it — never overwrite it with zeros.
    expect(privateStateWrites).toEqual([]);
    expect(privateState?.organizerSecretKey).toEqual(persistedKey);
  });

  it('refuses to join, rather than substituting a key, when the key is gone', async () => {
    chainAcceptsDeploymentAt(EVENT_A);
    const { providers, deployedAddress } = await deployVerifyAndActivate();

    privateState = null; // the browser lost it
    await expect(ZKEventAccessAPI.join(providers, deployedAddress as never)).rejects.toBeInstanceOf(
      OrganizerIdentityUnavailableError,
    );
    expect(ZK_EVENT_ACCESS_PRIVATE_STATE_ID).toBe('counterPrivateState');
  });
});

// ─── verify access must cost no transaction ─────────────────────────────────

describe('verifying access reads the public ledger without submitting anything', () => {
  it('returns the on-chain count with zero transaction submissions', async () => {
    chainAcceptsDeploymentAt(EVENT_A);
    const { providers, deployedAddress } = await deployVerifyAndActivate();

    // Spy on EVERY submitting path the SDK could offer. A verification that
    // touches any of them spends the wallet's single pending slot — which is
    // what produced "A transaction is already pending" for a read-only action.
    const increment = vi.fn(async () => undefined);
    const read = vi.fn(async () => undefined);
    findDeployedContractMock.mockImplementation(async (_p: ZKEventAccessProviders, options: any) => ({
      deployTxData: { public: { contractAddress: options.contractAddress, txHash: '0x1' } },
      callTx: { increment, read },
    }));

    const joined = await ZKEventAccessAPI.join(providers, deployedAddress as never);
    // This single call is what "Verify access" now does.
    const ledgerState = await joined.readLatest();

    expect(ledgerState.counter).toBe(0n);
    // The organizer's on-chain commitment is readable too, which is why the
    // pre-flight check is free as well.
    expect(ledgerState.organizer).toMatch(/^[0-9a-f]{64}$/);
    expect(increment).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('offers no transaction-submitting read method to regress back to', async () => {
    chainAcceptsDeploymentAt(EVENT_A);
    const { providers, deployedAddress } = await deployVerifyAndActivate();
    findDeployedContractMock.mockImplementation(async (_p: ZKEventAccessProviders, options: any) => ({
      deployTxData: { public: { contractAddress: options.contractAddress, txHash: '0x1' } },
      callTx: { increment: vi.fn(), read: vi.fn() },
    }));

    const joined = await ZKEventAccessAPI.join(providers, deployedAddress as never);
    // The old `read()` (a proof plus a submission for a value that is already
    // public) is gone, so it cannot be wired back into the UI by accident.
    expect((joined as unknown as Record<string, unknown>).read).toBeUndefined();
  });

  it('keeps `callTx.read` out of the application source entirely', () => {
    // A source-level guard: the contract's `read` circuit is public state, so no
    // UI path may spend a transaction on it. The only remaining call site is the
    // SDK type itself, never application code.
    //
    // Comments are stripped first, so the explanation of WHY this is forbidden
    // may name the forbidden call without tripping the guard.
    const stripComments = (code: string): string =>
      code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (/\.tsx?$/.test(entry.name) && stripComments(readFileSync(path, 'utf8')).includes('callTx.read(')) {
          offenders.push(path);
        }
      }
    };
    walk(resolve(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});

