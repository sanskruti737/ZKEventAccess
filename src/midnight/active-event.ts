/**
 * Local bookkeeping for the browser's ACTIVE event contract.
 *
 * The value stored here is PUBLIC data only — a contract address, an
 * organizer commitment hash, and a status word. No secret key is ever written
 * to this module's storage.
 *
 * ── Why this is a state machine and not just an address ───────────────────────
 *
 * A contract address on its own is NOT permission to use an event. The contract
 * only lets its registered organizer increment, so an address whose on-chain
 * `organizer` commitment does not match the connected 1AM wallet is unusable no
 * matter how it got into storage. Three situations are therefore recorded
 * explicitly and must never be conflated:
 *
 *   1. `unconfigured`        nothing stored — no event has been deployed here.
 *   2. `unverified`          a deployment finalized on-chain but its organizer
 *                            commitment was NOT (yet) checked against the
 *                            connected wallet. The address is remembered so the
 *                            event is not orphaned, but it is NOT usable.
 *   3. `verified`            deployment finalized AND the on-chain organizer
 *                            commitment was read from the indexer and matched
 *                            the connected wallet. This is the ONLY state that
 *                            "Issue credential" and "Verify access" may use.
 *
 * plus two terminal-until-redeployed states:
 *
 *   4. `foreign-organizer`   the stored event's on-chain organizer belongs to a
 *                            different wallet.
 *   5. `stale-build`         the stored event was deployed from a different
 *                            build of the contract, so this client can never
 *                            call it (mismatched verifier keys).
 *
 * ── Why there is deliberately NO build-time address fallback ─────────────────
 *
 * An address coming from build-time configuration (a `VITE_`-prefixed
 * environment variable) was never deployed by, nor registered to, the connected
 * wallet. Adopting it would move the app straight into state 4 and every Issue
 * would revert on-chain. The wallet-backed deploy flow is the only supported way
 * to obtain an event, so this module never reads a build-time default. If
 * nothing is verified, the app says so and asks the user to deploy; it does not
 * invent an event. tests/active-event.test.ts enforces that this module reads no
 * build-time environment configuration and names no build-time address variable
 * at all.
 */

export const ACTIVE_EVENT_KEY = 'zkEventAccess.activeEvent.v1';

/**
 * Legacy keys written by earlier builds, which stored a bare address and a bare
 * organizer commitment with no status word. They are read once for migration and
 * then removed. A legacy address is migrated to `unverified`, never to
 * `verified`: the old build could not distinguish "checked" from "not checked",
 * so fail-closed is the only safe reading.
 */
const LEGACY_ADDRESS_KEY = 'zkEventAccess.deployedContractAddress';
const LEGACY_ORGANIZER_KEY = 'zkEventAccess.activeEventOrganizer';

const ADDRESS_PATTERN = /^(0x)?[0-9a-fA-F]{24,128}$/;
const COMMITMENT_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

export const isValidContractAddress = (value: unknown): value is string =>
  typeof value === 'string' && ADDRESS_PATTERN.test(value.trim());

export const isValidOrganizerCommitment = (value: unknown): value is string =>
  typeof value === 'string' && COMMITMENT_PATTERN.test(value.trim());

/** How far a stored event has progressed towards being usable. */
export type ActiveEventStatus =
  /** Nothing is stored: this browser has no wallet-backed event. */
  | 'unconfigured'
  /** A deployment finalized on-chain but the organizer was never verified. */
  | 'unverified'
  /** Deployment finalized AND the on-chain organizer matched the connected wallet. */
  | 'verified'
  /** The stored event's on-chain organizer belongs to a different wallet. */
  | 'foreign-organizer'
  /** The stored event came from a different contract build and is uncallable. */
  | 'stale-build';

/** A stored event. Every field is public. */
export interface ActiveEventRecord {
  readonly address: string;
  readonly status: Exclude<ActiveEventStatus, 'unconfigured'>;
  /** The on-chain organizer commitment. Present only once verified. */
  readonly organizer?: string;
  /** Human-readable explanation, set when the record is not `verified`. */
  readonly reason?: string;
  readonly updatedAt: number;
}

/** localStorage is unavailable in non-browser contexts and can throw when blocked. */
const storage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

const readItem = (key: string): string | undefined => {
  try {
    const value = storage()?.getItem(key);
    return value ?? undefined;
  } catch {
    return undefined;
  }
};

const writeItem = (key: string, value: string): void => {
  try {
    storage()?.setItem(key, value);
  } catch {
    // storage unavailable — the in-session event still works
  }
};

const removeItem = (key: string): void => {
  try {
    storage()?.removeItem(key);
  } catch {
    // storage unavailable — nothing persisted to forget
  }
};

const parseRecord = (raw: string | undefined): ActiveEventRecord | undefined => {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const candidate = parsed as Partial<ActiveEventRecord> & { v?: unknown };
  if (candidate.v !== 1) return undefined;
  if (!isValidContractAddress(candidate.address)) return undefined;
  const status = candidate.status;
  if (
    status !== 'unverified' &&
    status !== 'verified' &&
    status !== 'foreign-organizer' &&
    status !== 'stale-build'
  ) {
    return undefined;
  }
  // A `verified` record without its organizer commitment is not trustworthy:
  // the commitment is the only evidence the verification actually happened.
  const organizer = isValidOrganizerCommitment(candidate.organizer) ? candidate.organizer.trim() : undefined;
  if (status === 'verified' && !organizer) return undefined;
  return {
    address: (candidate.address as string).trim(),
    status,
    organizer: status === 'verified' ? organizer : undefined,
    reason: typeof candidate.reason === 'string' ? candidate.reason : undefined,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
  };
};

const writeRecord = (record: ActiveEventRecord): void => {
  writeItem(ACTIVE_EVENT_KEY, JSON.stringify({ v: 1, ...record }));
  // Any legacy bare keys are superseded; remove them so there is exactly one
  // source of truth and no stale value can be mistaken for a verified event.
  removeItem(LEGACY_ADDRESS_KEY);
  removeItem(LEGACY_ORGANIZER_KEY);
};

const migrateLegacy = (): ActiveEventRecord | undefined => {
  const address = readItem(LEGACY_ADDRESS_KEY);
  if (!isValidContractAddress(address)) {
    removeItem(LEGACY_ADDRESS_KEY);
    removeItem(LEGACY_ORGANIZER_KEY);
    return undefined;
  }
  // Old builds recorded the organizer commitment BEFORE the deploy-time formula
  // was proven correct, so such a value cannot be trusted as verification.
  // Migrate to `unverified` and force a fresh, explicitly verified deploy.
  const migrated: ActiveEventRecord = {
    address: address.trim(),
    status: 'unverified',
    reason:
      'This browser had an event saved by an older build that could not prove it was owned by the ' +
      'connected wallet. It is not activated. Deploy a new wallet-backed event to verify ownership.',
    updatedAt: 0,
  };
  writeRecord(migrated);
  return migrated;
};

/** The stored event, migrating legacy storage on first read. `undefined` = unconfigured. */
export const readActiveEventRecord = (): ActiveEventRecord | undefined =>
  parseRecord(readItem(ACTIVE_EVENT_KEY)) ?? migrateLegacy();

/**
 * The ONLY address that "Issue credential" and "Verify access" may act on.
 *
 * Returns the address solely when its stored status is `verified`, i.e. a
 * deployment finalized on-chain and its on-chain organizer commitment was read
 * back and matched against the connected 1AM wallet. Every other status —
 * including a perfectly valid-looking address that was never checked — yields
 * `undefined`.
 */
export const readVerifiedActiveEventAddress = (): string | undefined => {
  const record = readActiveEventRecord();
  return record?.status === 'verified' ? record.address : undefined;
};

/** Any address this browser knows about, whatever its status. Never use as the event to act on. */
export const readKnownActiveEventAddress = (): string | undefined => readActiveEventRecord()?.address;

/** The organizer commitment recorded for a verified event, if any. */
export const readStoredActiveEventOrganizer = (): string | undefined => {
  const record = readActiveEventRecord();
  return record?.status === 'verified' ? record.organizer : undefined;
};

/**
 * Records that a deployment transaction finalized on-chain but has NOT been
 * verified. The address is kept so the event is never orphaned or silently
 * forgotten, while remaining unusable until {@link recordVerifiedActiveEvent}
 * is called with a commitment that matched the chain.
 */
export const recordUnverifiedDeployment = (address: string): ActiveEventRecord | undefined => {
  if (!isValidContractAddress(address)) return readActiveEventRecord();
  const record: ActiveEventRecord = {
    address: address.trim(),
    status: 'unverified',
    reason: 'Deployed on-chain, but its on-chain organizer commitment has not been verified against the connected wallet yet.',
    updatedAt: Date.now(),
  };
  writeRecord(record);
  return record;
};

/**
 * Records a deployment as the ACTIVE event. This is the only transition that
 * makes an event usable, and it requires the organizer commitment that was read
 * back from the chain, so it cannot be reached without a successful comparison.
 */
export const recordVerifiedActiveEvent = (address: string, organizer: string): ActiveEventRecord | undefined => {
  if (!isValidContractAddress(address) || !isValidOrganizerCommitment(organizer)) return readActiveEventRecord();
  const record: ActiveEventRecord = {
    address: address.trim(),
    status: 'verified',
    organizer: organizer.trim(),
    updatedAt: Date.now(),
  };
  writeRecord(record);
  return record;
};

/**
 * Marks a stored event as unusable, KEEPING its address and the reason why.
 *
 * This never deletes anything: the user can still see which event was rejected
 * and why. It also never triggers a deployment of its own — recovery is always
 * an explicit user action, so a failure can never loop or spend funds silently.
 */
export const invalidateActiveEvent = (
  status: Extract<ActiveEventStatus, 'foreign-organizer' | 'stale-build'>,
  reason: string,
): ActiveEventRecord | undefined => {
  const current = readActiveEventRecord();
  if (!current) return undefined;
  const record: ActiveEventRecord = { ...current, status, reason, updatedAt: Date.now() };
  writeRecord(record);
  return record;
};

/** Explicit, user-requested removal. Never called from an error path. */
export const forgetActiveEvent = (): void => {
  removeItem(ACTIVE_EVENT_KEY);
  removeItem(LEGACY_ADDRESS_KEY);
  removeItem(LEGACY_ORGANIZER_KEY);
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
 * it. Says what failed and why — it never implies the action succeeded, and it
 * does not claim a redeployment is already under way.
 */
export const staleContractBuildMessage = (address: string, circuits: string[]): string => {
  const which = circuits.length > 0 ? circuits.join(', ') : 'the event circuits';
  return (
    `The event saved in this browser (${shorten(address)}) was deployed from a DIFFERENT build of the ` +
    `contract, so its on-chain verifier keys do not match this app version and ${which} can never be ` +
    `called on it. Nothing was issued. This event has been marked unusable — click "Deploy a new ` +
    `wallet-backed event" to register a fresh event for this wallet and approve the deployment in the 1AM ` +
    `wallet. The organizer's key stays in the wallet: no key is entered or stored.`
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

/** The exact wording shown when the stored event is registered to another wallet. */
export const FOREIGN_ORGANIZER_HEADLINE = 'Current event is owned by another wallet. Deploy a new wallet-backed event.';

/**
 * Truthful explanation when a stored or freshly deployed event belongs to a
 * different organizer. Never implies the event was usable or that anything was
 * issued, and never silently swaps in a different event.
 */
export const organizerMismatchMessage = (address: string, onChain: string, expected: string): string =>
  `${FOREIGN_ORGANIZER_HEADLINE} The event ${shorten(address)} is registered on-chain to organizer ` +
  `${onChain}, but the connected 1AM wallet's organizer commitment is ${expected}. Nothing was issued and ` +
  `nothing was changed on that event. Click "Deploy a new wallet-backed event" and approve the deployment in ` +
  `the wallet. No organizer key is ever entered, displayed, or stored.`;

/**
 * The gate every ledger action must pass. Returns the address to act on, or the
 * message to show the user. Nothing here reads build-time configuration, so an
 * unconfigured app can never end up pointed at a foreign event.
 */
export const requireVerifiedActiveEvent = (
  record: ActiveEventRecord | undefined,
): { readonly ok: true; readonly address: string } | { readonly ok: false; readonly message: string } => {
  if (!record) {
    return {
      ok: false,
      message:
        'No event contract address configured. Click "Deploy a new wallet-backed event" so this wallet becomes the on-chain organizer.',
    };
  }
  if (record.status === 'verified') return { ok: true, address: record.address };
  if (record.status === 'unverified') {
    return {
      ok: false,
      message:
        `A new event (${shorten(record.address)}) was deployed but its on-chain organizer has not been ` +
        `verified yet, so it is not active and nothing can be issued on it. Click "Deploy a new ` +
        `wallet-backed event" to deploy and verify one.`,
    };
  }
  if (record.status === 'foreign-organizer') {
    return { ok: false, message: `${FOREIGN_ORGANIZER_HEADLINE} ${record.reason ?? ''}`.trim() };
  }
  return {
    ok: false,
    message:
      record.reason ??
      `The event saved in this browser (${shorten(record.address)}) cannot be used by this app. Click "Deploy a new wallet-backed event".`,
  };
};
