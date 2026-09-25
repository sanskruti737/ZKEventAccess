/**
 * Local bookkeeping for the browser's ACTIVE event contract address.
 *
 * The stored value is a PUBLIC contract identifier only — no secret key is ever
 * written here — and it exists so a page reload can re-join the same event
 * instead of deploying a new one on every visit.
 *
 * The address alone is not enough to make that safe, though. A deployed contract
 * instance is only callable by a client build whose circuit verifier keys match
 * the keys the instance registered at deployment time. Any change to the Compact
 * source (or to the compiler that produced it) changes those keys, so a persisted
 * address can point at an event that the current build can never call. In that
 * case midnight-js-contracts refuses to join it with
 *
 *   Following operations: increment, decrement, ..., are undefined or have
 *   mismatched verifier keys for contract state ContractState (...)
 *
 * (ContractTypeError) and every action against that event fails. This module
 * recognises that signal so the app can drop the unusable address and redeploy
 * from the CURRENT artifacts instead of leaving the user on a dead event.
 */

/** Public (non-secret) contract address of an event deployed from this browser. */
export const ACTIVE_EVENT_ADDRESS_KEY = 'zkEventAccess.deployedContractAddress';

/**
 * Public organizer commitment that was verified on-chain for the active event.
 *
 * This is PUBLIC ledger data (a hash already stored in the `organizer` cell),
 * never key material. Persisting it lets the app validate on load — with no
 * wallet prompt and no key derivation — that the saved event really is owned by
 * the wallet that deployed it, so Verify access never reads a foreign event.
 */
export const ACTIVE_EVENT_ORGANIZER_KEY = 'zkEventAccess.activeEventOrganizer';

const ADDRESS_PATTERN = /^(0x)?[0-9a-fA-F]{24,128}$/;

export const isValidContractAddress = (value: unknown): value is string =>
  typeof value === 'string' && ADDRESS_PATTERN.test(value.trim());

/** localStorage is unavailable in non-browser contexts and can throw when blocked. */
const storage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export const readStoredActiveEventAddress = (): string | undefined => {
  const stored = storage()?.getItem(ACTIVE_EVENT_ADDRESS_KEY);
  return stored && isValidContractAddress(stored) ? stored.trim() : undefined;
};

export const writeStoredActiveEventAddress = (address: string): void => {
  if (!isValidContractAddress(address)) return;
  try {
    storage()?.setItem(ACTIVE_EVENT_ADDRESS_KEY, address.trim());
  } catch {
    // storage unavailable — the in-session event still works
  }
};

/** Persist the active event together with its verified on-chain organizer commitment. */
export const writeStoredActiveEvent = (address: string, organizer: string): void => {
  writeStoredActiveEventAddress(address);
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(organizer.trim())) return;
  try {
    storage()?.setItem(ACTIVE_EVENT_ORGANIZER_KEY, organizer.trim());
  } catch {
    // storage unavailable — ownership is still re-checked at Issue time
  }
};

/** The organizer commitment recorded for the active event, if any. */
export const readStoredActiveEventOrganizer = (): string | undefined => {
  const stored = storage()?.getItem(ACTIVE_EVENT_ORGANIZER_KEY);
  return stored && /^(0x)?[0-9a-fA-F]{64}$/.test(stored.trim()) ? stored.trim() : undefined;
};

export const clearStoredActiveEventAddress = (): void => {
  try {
    storage()?.removeItem(ACTIVE_EVENT_ADDRESS_KEY);
    storage()?.removeItem(ACTIVE_EVENT_ORGANIZER_KEY);
  } catch {
    // storage unavailable — nothing persisted to forget
  }
};

/**
 * True when an error means "this event was deployed from a DIFFERENT contract
 * build than the one this client ships", i.e. the deployed instance does not
 * register verifier keys for the circuits this build calls.
 *
 * midnight-js-contracts throws `ContractTypeError`, which extends TypeError and
 * does not override `name` — so detection is structural (its `circuitIds` field,
 * populated with the circuits that were undefined or mismatched) with the
 * message text as a fallback for SDK builds that do not carry the field.
 */
export const isStaleContractBuildError = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const { circuitIds, message } = err as { circuitIds?: unknown; message?: unknown };
  if (Array.isArray(circuitIds)) return true;
  return typeof message === 'string' && /mismatched verifier keys/i.test(message);
};

/** The circuits the SDK reported as undefined or mismatched, when available. */
export const staleContractBuildCircuits = (err: unknown): string[] => {
  if (typeof err !== 'object' || err === null) return [];
  const { circuitIds } = err as { circuitIds?: unknown };
  return Array.isArray(circuitIds) ? circuitIds.filter((id): id is string => typeof id === 'string') : [];
};

const shorten = (address: string): string =>
  address.length > 26 ? `${address.slice(0, 14)}…${address.slice(-10)}` : address;

/**
 * Truthful explanation of a stale-build event, including what the app does about
 * it. Says what failed and why — it never implies the action succeeded.
 */
export const staleContractBuildMessage = (address: string, circuits: string[]): string => {
  const which = circuits.length > 0 ? circuits.join(', ') : 'the event circuits';
  return (
    `The event saved in this browser (${shorten(address)}) was deployed from a DIFFERENT build of the ` +
    `contract, so its on-chain verifier keys do not match this app version and ${which} can never be ` +
    `called on it. Nothing was issued. The event has been unset and a new event is being deployed from ` +
    `the current contract through your connected 1AM wallet — approve the deployment in the wallet, then ` +
    `Issue credential / Verify access will run against the new event. The organizer's key stays in the ` +
    `wallet: no key is entered or stored.`
  );
};

/**
 * True when the connected wallet's organizer identity is not the organizer
 * registered on-chain for `address`. The active event is then unusable for
 * issuing: only its true organizer can increment, so the wallet must deploy a
 * new event that it owns rather than keep retrying against this one.
 */
export const isOrganizerMismatch = (expected: string | undefined, onChain: string | undefined): boolean =>
  typeof expected === 'string' &&
  typeof onChain === 'string' &&
  expected.toLowerCase() !== onChain.toLowerCase();

/**
 * Truthful explanation when the active event belongs to a different organizer.
 * Never implies the current event was usable or that anything was issued.
 */
export const organizerMismatchMessage = (address: string, onChain: string, expected: string): string =>
  `The event saved in this browser (${shorten(address)}) is registered on-chain to a different organizer ` +
  `(on-chain ${onChain} ≠ connected 1AM wallet ${expected}), so this wallet cannot issue credentials on it. ` +
  `Nothing was issued and nothing was changed on that event. It has been unset, and a new event is being ` +
  `deployed through your connected 1AM wallet so that your wallet becomes its on-chain organizer — approve the ` +
  `deployment in the wallet. No organizer key is ever entered, displayed, or stored.`;
