import { describe, expect, it, afterEach } from 'vitest';
import {
  ACTIVE_EVENT_ADDRESS_KEY,
  ACTIVE_EVENT_ORGANIZER_KEY,
  clearStoredActiveEventAddress,
  isOrganizerMismatch,
  isStaleContractBuildError,
  isValidContractAddress,
  organizerMismatchMessage,
  readStoredActiveEventAddress,
  readStoredActiveEventOrganizer,
  staleContractBuildCircuits,
  staleContractBuildMessage,
  writeStoredActiveEvent,
  writeStoredActiveEventAddress,
} from '../src/midnight/active-event';

const REAL_ADDRESS = 'fb24191c6928e59a9490942d6343fb6facfb5a19965c1f85096c06c78af6fc8e';

describe('isValidContractAddress', () => {
  it('accepts the hex address format the SDK returns', () => {
    expect(isValidContractAddress(REAL_ADDRESS)).toBe(true);
    expect(isValidContractAddress(`0x${REAL_ADDRESS}`)).toBe(true);
    expect(isValidContractAddress(`  ${REAL_ADDRESS}  `)).toBe(true);
  });

  it('rejects anything that is not a hex address', () => {
    expect(isValidContractAddress('')).toBe(false);
    expect(isValidContractAddress('0x1234')).toBe(false);
    expect(isValidContractAddress(`${REAL_ADDRESS}zz`)).toBe(false);
    expect(isValidContractAddress(undefined)).toBe(false);
    expect(isValidContractAddress(null)).toBe(false);
    expect(isValidContractAddress(42)).toBe(false);
  });
});

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
    const message = staleContractBuildMessage(REAL_ADDRESS, ['increment', 'rotate']);
    expect(message).toContain(`${REAL_ADDRESS.slice(0, 14)}…${REAL_ADDRESS.slice(-10)}`);
    expect(message).toContain('increment, rotate');
    expect(message).toContain('Nothing was issued');
    expect(message).toMatch(/no key is entered or stored/i);
  });
});

// ─── Ownership validation + single authoritative active-event source ───────────

/** Minimal in-memory localStorage so the storage contract can be tested in node. */
const installLocalStorage = (): Map<string, string> => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  return store;
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

const COMMITMENT_A = `2c34bf22b0f0200057f09ff25d7165277dffc2c426694ffd52d26420e5a988a4`;
const COMMITMENT_B = `afb017945b6acb2dba775abf34c7af4abd0d0c60056f6e367763005d69eb57d0`;

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
    const msg = organizerMismatchMessage(REAL_ADDRESS, COMMITMENT_A, COMMITMENT_B);
    expect(msg).toContain(COMMITMENT_A);
    expect(msg).toContain(COMMITMENT_B);
    expect(msg).toContain('Nothing was issued');
    expect(msg).toMatch(/approve the\s+deployment in the wallet/i);
    expect(msg).toMatch(/no organizer key is ever entered, displayed, or stored/i);
  });
});

describe('active-event storage is the single authoritative source', () => {
  it('round-trips the address and its verified organizer commitment', () => {
    const store = installLocalStorage();
    writeStoredActiveEvent(REAL_ADDRESS, COMMITMENT_B);

    expect(store.get(ACTIVE_EVENT_ADDRESS_KEY)).toBe(REAL_ADDRESS);
    expect(store.get(ACTIVE_EVENT_ORGANIZER_KEY)).toBe(COMMITMENT_B);
    expect(readStoredActiveEventAddress()).toBe(REAL_ADDRESS);
    expect(readStoredActiveEventOrganizer()).toBe(COMMITMENT_B);
  });

  it('clears both keys, and only those keys, when abandoning a stale event', () => {
    const store = installLocalStorage();
    store.set('unrelated.app.setting', 'keep me');
    writeStoredActiveEvent(REAL_ADDRESS, COMMITMENT_B);

    clearStoredActiveEventAddress();

    expect(readStoredActiveEventAddress()).toBeUndefined();
    expect(readStoredActiveEventOrganizer()).toBeUndefined();
    // Never a blanket localStorage.clear() — other apps' state is untouched.
    expect(store.get('unrelated.app.setting')).toBe('keep me');
  });

  it('never persists a non-address or a non-commitment', () => {
    const store = installLocalStorage();
    writeStoredActiveEventAddress('not-an-address');
    expect(store.get(ACTIVE_EVENT_ADDRESS_KEY)).toBeUndefined();

    writeStoredActiveEvent(REAL_ADDRESS, 'too-short');
    expect(store.get(ACTIVE_EVENT_ORGANIZER_KEY)).toBeUndefined();
  });
});

describe('organizer commitment shape', () => {
  it('accepts exactly 32 bytes of hex and rejects anything else', () => {
    const store = installLocalStorage();
    // 64 hex chars == 32 bytes == a real persistentHash output.
    writeStoredActiveEvent(REAL_ADDRESS, 'a'.repeat(64));
    expect(readStoredActiveEventOrganizer()).toBe('a'.repeat(64));

    // A 65-char value cannot be a 32-byte commitment and must not be trusted.
    clearStoredActiveEventAddress();
    writeStoredActiveEvent(REAL_ADDRESS, 'a'.repeat(65));
    expect(readStoredActiveEventOrganizer()).toBeUndefined();
    expect(store.get(ACTIVE_EVENT_ORGANIZER_KEY)).toBeUndefined();
  });
});
