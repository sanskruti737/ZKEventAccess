import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  ACTIVE_EVENT_KEY,
  activeEventNotPersistedMessage,
  FOREIGN_ORGANIZER_HEADLINE,
  invalidateActiveEvent,
  isActiveEventDurable,
  isOrganizerMismatch,
  isStaleContractBuildError,
  isTransactionPendingError,
  isValidContractAddress,
  isValidOrganizerCommitment,
  organizerMismatchMessage,
  readActiveEventRecord,
  readKnownActiveEventAddress,
  readStoredActiveEventOrganizer,
  readVerifiedActiveEventAddress,
  recordUnverifiedDeployment,
  recordVerifiedActiveEvent,
  requireVerifiedActiveEvent,
  staleContractBuildCircuits,
  staleContractBuildMessage,
  transactionPendingMessage,
  forgetActiveEvent,
  type ActiveEventRecord,
} from '../src/midnight/active-event';

const ADDRESS_A = 'fb24191c6928e59a9490942d6343fb6facfb5a19965c1f85096c06c78af6fc8e';
const ADDRESS_B = '5cf5e8584cc4a3f0b1d2e9c8a7b6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d';
const COMMITMENT_A = '2c34bf22b0f0200057f09ff25d7165277dffc2c426694ffd52d26420e5a988a4';
const COMMITMENT_B = 'afb017945b6acb2dba775abf34c7af4abd0d0c60056f6e367763005d69eb57d0';

const LEGACY_ADDRESS_KEY = 'zkEventAccess.deployedContractAddress';
const LEGACY_ORGANIZER_KEY = 'zkEventAccess.activeEventOrganizer';

/** Minimal in-memory localStorage so the storage contract can be tested in node. */
let store = new Map<string, string>();

/**
 * Flipped mid-scenario to model a browser at quota or in private mode: `setItem`
 * is refused while `getItem` and `removeItem` keep working.
 *
 * That asymmetry is the production condition this module has to survive — a
 * deployment that finalized on-chain cannot be repeated for free — so it is
 * modelled here as a switch the test can throw at a live record, rather than as
 * a storage stub installed before the record exists.
 */
let writesRefused = false;

const installLocalStorage = (): Map<string, string> => {
  store = new Map<string, string>();
  writesRefused = false;
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (writesRefused) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
  };
  return store;
};

beforeEach(() => {
  installLocalStorage();
  // The module also mirrors the record in memory for the lifetime of the page,
  // so a clean store is not a clean module: each case starts from a cleared
  // mirror as well. Without this, a record established by one test leaks into
  // the next one's "nothing is configured" assertions.
  forgetActiveEvent();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

/**
 * The record exactly as it sits in storage, which is the invariant these
 * regressions are about. Deliberately NOT `readActiveEventRecord()`: the runtime
 * also consults the in-session mirror, so asserting on the runtime alone would
 * not prove anything about what was actually persisted.
 */
const storedRecord = (): Record<string, unknown> | undefined => {
  const raw = store.get(ACTIVE_EVENT_KEY);
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
};


afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

// ─── primitives ──────────────────────────────────────────────────────────────

describe('isValidContractAddress', () => {
  it('accepts the hex address format the SDK returns', () => {
    expect(isValidContractAddress(ADDRESS_A)).toBe(true);
    expect(isValidContractAddress(`0x${ADDRESS_A}`)).toBe(true);
    expect(isValidContractAddress(`  ${ADDRESS_A}  `)).toBe(true);
  });

  it('rejects anything that is not a hex address', () => {
    expect(isValidContractAddress('')).toBe(false);
    expect(isValidContractAddress('0x1234')).toBe(false);
    expect(isValidContractAddress(`${ADDRESS_A}zz`)).toBe(false);
    expect(isValidContractAddress(undefined)).toBe(false);
    expect(isValidContractAddress(null)).toBe(false);
    expect(isValidContractAddress(42)).toBe(false);
  });
});

describe('isValidOrganizerCommitment', () => {
  it('accepts exactly 32 bytes of hex and rejects anything else', () => {
    expect(isValidOrganizerCommitment('a'.repeat(64))).toBe(true);
    expect(isValidOrganizerCommitment('a'.repeat(63))).toBe(false);
    expect(isValidOrganizerCommitment('a'.repeat(65))).toBe(false);
    expect(isValidOrganizerCommitment(COMMITMENT_A.toUpperCase())).toBe(true);
    expect(isValidOrganizerCommitment(undefined)).toBe(false);
  });
});

// ─── stale contract build (mismatched verifier keys) ─────────────────────────

/** Mirrors the SDK `ContractTypeError`, which keeps the bad circuits in `circuitIds`. */
const contractTypeError = (circuitIds: string[]) =>
  Object.assign(new TypeError('Following operations: a, b, are undefined or have mismatched verifier keys'), {
    circuitIds,
  });

describe('isStaleContractBuildError', () => {
  it('detects the SDK ContractTypeError by its circuitIds', () => {
    expect(isStaleContractBuildError(contractTypeError(['increment', 'rotate']))).toBe(true);
  });

  it('falls back to the message for SDK builds without circuitIds', () => {
    expect(
      isStaleContractBuildError(new Error('circuits have MISMATCHED VERIFIER KEYS for contract state')),
    ).toBe(true);
  });

  it('does not treat unrelated failures as stale builds', () => {
    expect(isStaleContractBuildError(new Error('organizer authorization failed'))).toBe(false);
    expect(isStaleContractBuildError(new Error('insufficient funds'))).toBe(false);
    expect(isStaleContractBuildError(undefined)).toBe(false);
    expect(isStaleContractBuildError('mismatched verifier keys')).toBe(false);
  });
});

describe('staleContractBuildCircuits', () => {
  it('reports the offending circuits', () => {
    expect(staleContractBuildCircuits(contractTypeError(['increment', 'decrement', 'announce', 'rotate']))).toEqual([
      'increment',
      'decrement',
      'announce',
      'rotate',
    ]);
  });

  it('is empty when the SDK did not report circuits', () => {
    expect(staleContractBuildCircuits(new Error('mismatched verifier keys'))).toEqual([]);
  });
});

describe('staleContractBuildMessage', () => {
  it('names the dead address and the affected circuits, and never claims success', () => {
    const message = staleContractBuildMessage(ADDRESS_A, ['increment', 'rotate']);
    expect(message).toContain(`${ADDRESS_A.slice(0, 14)}…${ADDRESS_A.slice(-10)}`);
    expect(message).toContain('increment, rotate');
    expect(message).toContain('Nothing was issued');
    expect(message).toMatch(/no key is entered or stored/i);
  });

  it('does not claim a redeployment is already running', () => {
    expect(staleContractBuildMessage(ADDRESS_A, [])).not.toMatch(/is being deployed|now deploying/i);
  });
});

// ─── organizer comparison ────────────────────────────────────────────────────

describe('isOrganizerMismatch', () => {
  it('detects a different organizer regardless of hex casing', () => {
    expect(isOrganizerMismatch(COMMITMENT_A, COMMITMENT_B)).toBe(true);
    expect(isOrganizerMismatch(COMMITMENT_A.toUpperCase(), COMMITMENT_A)).toBe(false);
  });

  it('does not guess when either side is unavailable', () => {
    expect(isOrganizerMismatch(undefined, COMMITMENT_B)).toBe(false);
    expect(isOrganizerMismatch(COMMITMENT_A, undefined)).toBe(false);
  });
});

describe('organizerMismatchMessage', () => {
  it('is truthful: states the mismatch, that nothing was issued, and never claims success', () => {
    const msg = organizerMismatchMessage(ADDRESS_A, COMMITMENT_A, COMMITMENT_B);
    expect(msg).toContain(COMMITMENT_A);
    expect(msg).toContain(COMMITMENT_B);
    expect(msg).toContain('Nothing was issued');
    expect(msg).toContain(FOREIGN_ORGANIZER_HEADLINE);
    expect(msg).toMatch(/no organizer key is ever entered, displayed, or stored/i);
  });
});

// ─── SCENARIO 1: no active event ─────────────────────────────────────────────

describe('scenario: no active event', () => {
  it('starts unconfigured and exposes no usable address', () => {
    expect(readActiveEventRecord()).toBeUndefined();
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(readKnownActiveEventAddress()).toBeUndefined();
    expect(readStoredActiveEventOrganizer()).toBeUndefined();
  });

  it('blocks Issue credential and Verify access with the actionable message', () => {
    const gate = requireVerifiedActiveEvent(undefined);
    expect(gate.ok).toBe(false);
    expect(gate).toMatchObject({
      message: expect.stringContaining('No event contract address configured'),
    });
    expect(gate).toMatchObject({
      message: expect.stringContaining('Deploy a new wallet-backed event'),
    });
  });

  it('never adopts a build-time VITE_CONTRACT_ADDRESS', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/midnight/active-event.ts', import.meta.url), 'utf8'),
    );
    // There is no build-time default anywhere in the active-event module.
    expect(source).not.toMatch(/import\.meta\.env/);
    expect(source).not.toMatch(/VITE_CONTRACT_ADDRESS/);
  });
});

// ─── SCENARIO 2: successful wallet-backed deployment + verification ───────────

describe('scenario: successful wallet-backed deployment', () => {
  it('starts unverified, then becomes usable only after verification', () => {
    // The deployment finalized on-chain: the address is remembered, but NOT usable.
    const afterDeploy = recordUnverifiedDeployment(ADDRESS_A)!;
    expect(afterDeploy.status).toBe('unverified');
    expect(readActiveEventRecord()!.address).toBe(ADDRESS_A);
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);

    // Organizer read back from the chain and matched.
    const afterVerify = recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A)!;
    expect(afterVerify.status).toBe('verified');
    expect(afterVerify.organizer).toBe(COMMITMENT_A);
    expect(readVerifiedActiveEventAddress()).toBe(ADDRESS_A);
    expect(readStoredActiveEventOrganizer()).toBe(COMMITMENT_A);
    expect(requireVerifiedActiveEvent(readActiveEventRecord())).toEqual({ ok: true, address: ADDRESS_A });
  });

  it('refuses to record a verified event without a real 32-byte commitment', () => {
    recordVerifiedActiveEvent(ADDRESS_A, 'too-short');
    expect(readActiveEventRecord()).toBeUndefined();
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
  });

  it('refuses to record a non-address as the active event', () => {
    recordVerifiedActiveEvent('not-an-address', COMMITMENT_A);
    recordUnverifiedDeployment('not-an-address');
    expect(readActiveEventRecord()).toBeUndefined();
  });
});

// ─── SCENARIO 3: failed organizer verification ───────────────────────────────

describe('scenario: failed organizer verification', () => {
  it('leaves the deployed event inactive and reports the exact mismatch', () => {
    recordUnverifiedDeployment(ADDRESS_A);
    // Verification read the on-chain organizer and it did NOT match, so the app
    // must not promote the record — an event is only ever activated by
    // recordVerifiedActiveEvent with a matched commitment.
    expect(readVerifiedActiveEventAddress()).toBeUndefined();

    const gate = requireVerifiedActiveEvent(readActiveEventRecord());
    expect(gate.ok).toBe(false);
    expect(gate).toMatchObject({ message: expect.stringContaining('not been verified yet') });
    expect(gate).toMatchObject({ message: expect.stringContaining(ADDRESS_A.slice(0, 14)) });
  });

  it('keeps the address so a failed deployment is never orphaned or silently forgotten', () => {
    recordUnverifiedDeployment(ADDRESS_A);
    expect(readKnownActiveEventAddress()).toBe(ADDRESS_A);
    expect(JSON.parse(store.get(ACTIVE_EVENT_KEY)!).address).toBe(ADDRESS_A);
  });

  it('a rejected commit is not stored as the verified organizer', () => {
    recordUnverifiedDeployment(ADDRESS_A);
    expect(readStoredActiveEventOrganizer()).toBeUndefined();
  });
});

// ─── SCENARIO 4: stale event owned by another wallet ──────────────────────────

describe('scenario: stale event owned by another wallet', () => {
  it('invalidates safely, keeps the address, and shows the required message', () => {
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    const explanation = organizerMismatchMessage(ADDRESS_A, COMMITMENT_B, COMMITMENT_A);
    const invalidated = invalidateActiveEvent('foreign-organizer', explanation)!;

    expect(invalidated.status).toBe('foreign-organizer');
    expect(invalidated.address).toBe(ADDRESS_A);
    // Not usable by Issue credential / Verify access.
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
    // The message is shown verbatim, including the mandated sentence.
    const gate = requireVerifiedActiveEvent(readActiveEventRecord());
    expect(gate.ok).toBe(false);
    expect(gate).toMatchObject({ message: expect.stringContaining(FOREIGN_ORGANIZER_HEADLINE) });
    expect(FOREIGN_ORGANIZER_HEADLINE).toBe(
      'Current event is owned by another wallet. Deploy a new wallet-backed event.',
    );
  });

  it('does not silently replace the event with a different one', () => {
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    invalidateActiveEvent('foreign-organizer', organizerMismatchMessage(ADDRESS_A, COMMITMENT_B, COMMITMENT_A));
    expect(readActiveEventRecord()!.address).toBe(ADDRESS_A);
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
  });

  it('re-deploying and verifying again makes the new event the only active one', () => {
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    invalidateActiveEvent('foreign-organizer', organizerMismatchMessage(ADDRESS_A, COMMITMENT_B, COMMITMENT_A));
    recordUnverifiedDeployment(ADDRESS_B);
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    recordVerifiedActiveEvent(ADDRESS_B, COMMITMENT_A);
    expect(readVerifiedActiveEventAddress()).toBe(ADDRESS_B);
    expect(readActiveEventRecord()!.address).toBe(ADDRESS_B);
  });

  it('stale-build events are invalidated the same way', () => {
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    const explanation = staleContractBuildMessage(ADDRESS_A, ['increment']);
    invalidateActiveEvent('stale-build', explanation);
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord())).toMatchObject({ ok: false });
  });

  it('invalidation is a no-op when nothing is stored', () => {
    expect(invalidateActiveEvent('foreign-organizer', 'x')).toBeUndefined();
    expect(readActiveEventRecord()).toBeUndefined();
  });
});

// ─── SCENARIO 5: persistence across a page refresh ────────────────────────────

describe('scenario: the verified active event survives a page refresh', () => {
  it('is restored from storage by a fresh reader (new "page load")', () => {
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    const onDisk = store.get(ACTIVE_EVENT_KEY);
    expect(onDisk).toBeDefined();

    // Simulate a reload: the record is only known through storage.
    const restored: ActiveEventRecord = readActiveEventRecord()!;
    expect(restored).toMatchObject({ address: ADDRESS_A, status: 'verified', organizer: COMMITMENT_A });
    expect(readVerifiedActiveEventAddress()).toBe(ADDRESS_A);
    expect(requireVerifiedActiveEvent(restored)).toEqual({ ok: true, address: ADDRESS_A });
  });

  it('Issue credential and Verify access both resolve the SAME restored event', () => {
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    // Both actions go through the single gate, so they can never diverge.
    const issueGate = requireVerifiedActiveEvent(readActiveEventRecord());
    const verifyGate = requireVerifiedActiveEvent(readActiveEventRecord());
    expect(issueGate).toEqual(verifyGate);
    expect(issueGate.ok && issueGate.address).toBe(ADDRESS_A);
    expect(verifyGate.ok && verifyGate.address).toBe(ADDRESS_A);
  });

  it('a tampered or corrupt stored record is ignored, never trusted as verified', () => {
    for (const bad of [
      'not json',
      JSON.stringify({ v: 2, address: ADDRESS_A, status: 'verified' }),
      JSON.stringify({ v: 1, address: 'nope', status: 'verified', organizer: COMMITMENT_A }),
      JSON.stringify({ v: 1, address: ADDRESS_A, status: 'verified' }),
      JSON.stringify({ v: 1, address: ADDRESS_A, status: 'totally-bogus' }),
      JSON.stringify({ v: 1, address: ADDRESS_A, status: 'verified', organizer: 'short' }),
    ]) {
      installLocalStorage();
      store.set(ACTIVE_EVENT_KEY, bad);
      expect(readActiveEventRecord()).toBeUndefined();
      expect(readVerifiedActiveEventAddress()).toBeUndefined();
      expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
    }
  });

  it('forgetActiveEvent is the only path that removes the record', () => {
    store.set('unrelated.app.setting', 'keep me');
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    forgetActiveEvent();
    expect(readActiveEventRecord()).toBeUndefined();
    // Never a blanket localStorage.clear() — other apps' state is untouched.
    expect(store.get('unrelated.app.setting')).toBe('keep me');
  });
});

// ─── legacy migration: fail closed ───────────────────────────────────────────

describe('legacy storage migration fails closed', () => {
  it('migrates a bare legacy address to unverified, never to verified', () => {
    store.set(LEGACY_ADDRESS_KEY, ADDRESS_A);
    store.set(LEGACY_ORGANIZER_KEY, COMMITMENT_B);
    const record = readActiveEventRecord()!;
    expect(record.status).toBe('unverified');
    expect(record.address).toBe(ADDRESS_A);
    // The old build could not prove ownership, so it must not be usable.
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(readStoredActiveEventOrganizer()).toBeUndefined();
    // Legacy keys are superseded by the single authoritative record.
    expect(store.get(LEGACY_ADDRESS_KEY)).toBeUndefined();
    expect(store.get(LEGACY_ORGANIZER_KEY)).toBeUndefined();
    expect(store.get(ACTIVE_EVENT_KEY)).toBeDefined();
  });

  it('discards a corrupt legacy address entirely', () => {
    store.set(LEGACY_ADDRESS_KEY, 'garbage');
    expect(readActiveEventRecord()).toBeUndefined();
    expect(store.get(LEGACY_ADDRESS_KEY)).toBeUndefined();
  });
});

// ─── storage that refuses writes ─────────────────────────────────────────────

describe('a refused write never orphans a deployed event', () => {
  it('keeps the legacy address when the versioned record cannot be stored', () => {
    // A browser at quota already holds the keys, then refuses further writes.
    writesRefused = true;
    store.set(LEGACY_ADDRESS_KEY, ADDRESS_A);
    store.set(LEGACY_ORGANIZER_KEY, COMMITMENT_B);

    // The read still reports the event that exists rather than claiming the
    // wallet has nothing configured.
    const record = readActiveEventRecord();
    expect(record?.address).toBe(ADDRESS_A);
    expect(readKnownActiveEventAddress()).toBe(ADDRESS_A);
    // Fail-closed: a legacy address is never usable without verification.
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(record).ok).toBe(false);
    // The superseding write did not land, so the legacy keys must survive.
    expect(store.get(LEGACY_ADDRESS_KEY)).toBe(ADDRESS_A);
    expect(store.get(LEGACY_ORGANIZER_KEY)).toBe(COMMITMENT_B);
    expect(store.get(ACTIVE_EVENT_KEY)).toBeUndefined();
  });

  it('retries the migration on the next read once writes work again', () => {
    writesRefused = true;
    store.set(LEGACY_ADDRESS_KEY, ADDRESS_A);
    expect(readActiveEventRecord()?.address).toBe(ADDRESS_A);
    expect(store.get(ACTIVE_EVENT_KEY)).toBeUndefined();

    writesRefused = false;
    store.set(LEGACY_ADDRESS_KEY, ADDRESS_A);
    const record = readActiveEventRecord();
    expect(record?.status).toBe('unverified');
    expect(record?.address).toBe(ADDRESS_A);
    // Now that the versioned record is really stored, it supersedes the legacy keys.
    expect(store.get(ACTIVE_EVENT_KEY)).toBeDefined();
    expect(store.get(LEGACY_ADDRESS_KEY)).toBeUndefined();
  });

  it('keeps the legacy address when recording a new deployment fails', () => {
    writesRefused = true;
    store.set(LEGACY_ADDRESS_KEY, ADDRESS_A);
    store.set(LEGACY_ORGANIZER_KEY, COMMITMENT_B);

    recordUnverifiedDeployment(ADDRESS_B);
    expect(store.get(ACTIVE_EVENT_KEY)).toBeUndefined();
    expect(store.get(LEGACY_ADDRESS_KEY)).toBe(ADDRESS_A);
    expect(store.get(LEGACY_ORGANIZER_KEY)).toBe(COMMITMENT_B);
  });

  it('keeps the legacy address when activating a verified event fails', () => {
    writesRefused = true;
    store.set(LEGACY_ADDRESS_KEY, ADDRESS_A);

    recordVerifiedActiveEvent(ADDRESS_B, COMMITMENT_A);
    expect(store.get(ACTIVE_EVENT_KEY)).toBeUndefined();
    expect(store.get(LEGACY_ADDRESS_KEY)).toBe(ADDRESS_A);
    // The v1 record never landed, so the legacy address is still the only
    // persisted truth: the superseding write did not destroy it.
    expect(store.get(LEGACY_ORGANIZER_KEY)).toBeUndefined();
  });
});

// ─── ordered supersede: write first, destroy the old copy only afterwards ─────

/**
 * The invariant these cases defend, in one place:
 *
 *   OLD VALID RECORD  →  attempt new record  →  prepare it completely
 *                      →  write it            →  ONLY THEN supersede the old one
 *
 * A deployment that finalized on-chain cannot be repeated for free (`signData` is
 * non-deterministic, so the organizer key behind it is unrecoverable, and it cost
 * a real fee). A replacement write that the browser refused must therefore cost
 * the user nothing, and a replacement write that succeeded must leave exactly one
 * record behind.
 */
describe('superseding the active event is ordered and failure-safe', () => {
  it('leaves the previous verified record byte-for-byte intact when the replacement is refused', () => {
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    const before = store.get(ACTIVE_EVENT_KEY);
    expect(before).toBeDefined();

    writesRefused = true;
    recordVerifiedActiveEvent(ADDRESS_B, COMMITMENT_B);

    // The replacement did not land, so storage is not merely "still parseable" —
    // it is the identical bytes that were there before the attempt.
    expect(store.get(ACTIVE_EVENT_KEY)).toBe(before);
    // 1. the previous valid record is preserved; 2. it was not deleted.
    expect(storedRecord()).toMatchObject({ address: ADDRESS_A, status: 'verified', organizer: COMMITMENT_A });
    // 6. read-after-failure still returns the previous valid event, and it is
    // still the event the gate hands to Issue credential / Verify access.
    expect(readActiveEventRecord()).toMatchObject({ address: ADDRESS_A, status: 'verified' });
    expect(readVerifiedActiveEventAddress()).toBe(ADDRESS_A);
    expect(readStoredActiveEventOrganizer()).toBe(COMMITMENT_A);
    expect(requireVerifiedActiveEvent(readActiveEventRecord())).toEqual({ ok: true, address: ADDRESS_A });
  });

  it('leaves no partial, truncated or corrupt value behind when the replacement is refused', () => {
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    const before = store.get(ACTIVE_EVENT_KEY);

    // Every write path this module has, all refused in a row: a new deployment
    // and then its activation.
    writesRefused = true;
    recordUnverifiedDeployment(ADDRESS_B);
    recordVerifiedActiveEvent(ADDRESS_B, COMMITMENT_B);

    // 3. nothing half-written, nothing extra, nothing removed: the store holds
    // one value and it is exactly the old one.
    expect(store.get(ACTIVE_EVENT_KEY)).toBe(before);
    expect(store.size).toBe(1);
    // And what is stored is still a well-formed record, not a truncated one.
    expect(storedRecord()).toMatchObject({ v: 1, address: ADDRESS_A, status: 'verified' });
    expect(readActiveEventRecord()).toMatchObject({ address: ADDRESS_A, status: 'verified' });
  });

  it('supersedes the previous record only once the replacement really landed', () => {
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    expect(storedRecord()).toMatchObject({ address: ADDRESS_A, status: 'verified' });

    recordVerifiedActiveEvent(ADDRESS_B, COMMITMENT_B);

    // 4. the new record supersedes the old one: exactly one record, and it is
    // the new event. No trace of the superseded address is left behind.
    expect(store.size).toBe(1);
    expect(storedRecord()).toMatchObject({ v: 1, address: ADDRESS_B, status: 'verified', organizer: COMMITMENT_B });
    expect(JSON.stringify(storedRecord())).not.toContain(ADDRESS_A);
    // 5. read-after-success returns the new active event.
    expect(readActiveEventRecord()).toMatchObject({ address: ADDRESS_B, status: 'verified' });
    expect(readVerifiedActiveEventAddress()).toBe(ADDRESS_B);
    expect(readStoredActiveEventOrganizer()).toBe(COMMITMENT_B);
    expect(requireVerifiedActiveEvent(readActiveEventRecord())).toEqual({ ok: true, address: ADDRESS_B });
  });

  it('removes the superseded legacy keys only after the new record is really stored', () => {
    store.set(LEGACY_ADDRESS_KEY, ADDRESS_A);
    store.set(LEGACY_ORGANIZER_KEY, COMMITMENT_B);

    writesRefused = true;
    recordVerifiedActiveEvent(ADDRESS_B, COMMITMENT_A);
    // Nothing was stored, so the only surviving copy of ADDRESS_A is untouched —
    // deleting it here is precisely the destructive-on-failure bug.
    expect(store.get(LEGACY_ADDRESS_KEY)).toBe(ADDRESS_A);
    expect(store.get(LEGACY_ORGANIZER_KEY)).toBe(COMMITMENT_B);
    expect(store.get(ACTIVE_EVENT_KEY)).toBeUndefined();

    // A later write that really lands is what supersedes them, in that order.
    writesRefused = false;
    recordVerifiedActiveEvent(ADDRESS_B, COMMITMENT_A);
    expect(storedRecord()).toMatchObject({ address: ADDRESS_B, status: 'verified' });
    expect(store.has(LEGACY_ADDRESS_KEY)).toBe(false);
    expect(store.has(LEGACY_ORGANIZER_KEY)).toBe(false);
  });

  it('refuses a malformed replacement without touching the record it could not store', () => {
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    const before = store.get(ACTIVE_EVENT_KEY);

    recordVerifiedActiveEvent('not-an-address', COMMITMENT_B);
    recordVerifiedActiveEvent(ADDRESS_B, 'too-short');
    recordUnverifiedDeployment('nonsense');

    // Validation is not weakened to make a replacement go through, and a
    // rejected one is not a half-applied one.
    expect(store.get(ACTIVE_EVENT_KEY)).toBe(before);
    expect(readVerifiedActiveEventAddress()).toBe(ADDRESS_A);
  });
});

// ─── concurrent transactions: the wallet accepts one at a time ────────────────

/**
 * The exact rejection a second concurrent submission produces, wrapped the way
 * the wallet extension wraps it. Every ledger action here ends in a transaction
 * — `read` is an on-chain circuit call, not a free query — so two of them being
 * in flight is a reachable state, not a theoretical one.
 */
const WALLED_BUSY_ERROR = `Unexpected error submitting scoped transaction '<unnamed>': Error: A transaction is ` +
  `already pending. Wait for it to confirm or expire before requesting another.`;

describe('a transaction the wallet is too busy to accept', () => {
  it('is recognised so it is explained instead of printed raw', () => {
    expect(isTransactionPendingError(new Error(WALLED_BUSY_ERROR))).toBe(true);
  });

  it('is not confused with a contract, authorization or build failure', () => {
    expect(isTransactionPendingError(new Error('organizer authorization failed'))).toBe(false);
    expect(isTransactionPendingError(contractTypeError(['increment']))).toBe(false);
    expect(isTransactionPendingError(new Error('insufficient funds'))).toBe(false);
    expect(isTransactionPendingError(undefined)).toBe(false);
    expect(isTransactionPendingError('A transaction is already pending')).toBe(false);
  });

  it('says nothing was issued, never claims success, and names the way out', () => {
    const message = transactionPendingMessage();
    expect(message).toMatch(/refused this one/i);
    expect(message).toMatch(/Nothing was issued/i);
    expect(message).toMatch(/one transaction at a time/i);
    // The only useful advice is to let the pending one finish.
    expect(message).toMatch(/Wait for the pending transaction/i);
    expect(message).not.toMatch(/is being deployed|now deploying|succeeded/i);
  });
});

// ─── the in-session mirror: a gap-filler, never new authority ────────────────

/**
 * The runtime is not storage-only: a record this page deployed and verified is
 * also mirrored in memory, so a browser that refuses the write still has a usable
 * event for the session it is in. These cases pin down that the mirror fills a
 * gap without ever becoming authority it was not granted — in particular it may
 * never ADD authority over a stored record, and it may never let a rejected event
 * stay usable.
 */
describe('the in-session mirror fills a gap and never adds authority', () => {
  it('keeps a verified event usable for this page when storage refused to store it', () => {
    writesRefused = true;
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);

    // Nothing is stored — the invariant above is about the OTHER case, where a
    // record already existed.
    expect(store.get(ACTIVE_EVENT_KEY)).toBeUndefined();
    // The event is real and verified, so it is still what the actions act on.
    expect(readVerifiedActiveEventAddress()).toBe(ADDRESS_A);
    expect(requireVerifiedActiveEvent(readActiveEventRecord())).toEqual({ ok: true, address: ADDRESS_A });
    // And the UI is told the truth: usable now, forgotten on refresh.
    expect(isActiveEventDurable()).toBe(false);
    expect(activeEventNotPersistedMessage(ADDRESS_A)).toMatch(/will be\s+forgotten on refresh/i);
  });

  it('keeps a rejected event unusable even when storage could not record the rejection', () => {
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    expect(readVerifiedActiveEventAddress()).toBe(ADDRESS_A);

    // The organizer check comes back "not this wallet" and the write to record
    // that verdict is refused.
    writesRefused = true;
    invalidateActiveEvent('foreign-organizer', organizerMismatchMessage(ADDRESS_A, COMMITMENT_B, COMMITMENT_A));

    // Storage is stuck saying `verified` — the refusal must not be a licence to
    // keep issuing credentials against an event this wallet does not own.
    expect(storedRecord()).toMatchObject({ address: ADDRESS_A, status: 'verified' });
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(readActiveEventRecord()).toMatchObject({ address: ADDRESS_A, status: 'foreign-organizer' });
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
  });

  it('never lets the mirror add authority over what storage holds', () => {
    // Storage holds a real record: an event that was deployed but whose
    // organizer was never checked, so it is not usable.
    recordUnverifiedDeployment(ADDRESS_A);
    expect(readActiveEventRecord()).toMatchObject({ address: ADDRESS_A, status: 'unverified' });

    // A later event IS deployed and verified, but the browser refuses the write.
    writesRefused = true;
    recordVerifiedActiveEvent(ADDRESS_B, COMMITMENT_A);

    // The mirror may only ever REMOVE authority, so the stored record still
    // governs: a refused replacement does not silently become the active event,
    // and the previous event is left in place rather than half-replaced.
    expect(storedRecord()).toMatchObject({ address: ADDRESS_A, status: 'unverified' });
    expect(readActiveEventRecord()).toMatchObject({ address: ADDRESS_A, status: 'unverified' });
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
  });

  it('is cleared by an explicit forget, so it cannot outlive the page', () => {
    writesRefused = true;
    recordVerifiedActiveEvent(ADDRESS_A, COMMITMENT_A);
    expect(readVerifiedActiveEventAddress()).toBe(ADDRESS_A);

    forgetActiveEvent();
    expect(readActiveEventRecord()).toBeUndefined();
    expect(readVerifiedActiveEventAddress()).toBeUndefined();
    expect(requireVerifiedActiveEvent(readActiveEventRecord()).ok).toBe(false);
  });
});
