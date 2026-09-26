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
 *
 * ── Why a verified event can never be lost ─────────────────────────────────
 *
 * `localStorage.setItem` is allowed to fail while reads keep working, and the
 * wallet-backed deploy flow cannot simply be repeated: `signData` is
 * non-deterministic, so the organizer key behind the event cannot be
 * re-derived, and the deployment costs a real on-chain fee. A write that was
 * refused must therefore never be reported as a stored record, and must never
 * delete the copy it was meant to supersede. Both of those happened, and the
 * result was the production failure this module now guards against: a wallet
 * that had just deployed, and had just verified, a live on-chain event was told
 * it had "No event contract address configured" — pushed to pay for a duplicate
 * event while the one it owned was orphaned.
 *
 * So a record produced here is also held in memory for the lifetime of the page
 * (see {@link sessionRecord}), a refused superseding write leaves the value it
 * was superseding alone, and {@link isActiveEventDurable} lets the UI say out
 * loud when an event is real and verified but only remembered by this tab.
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

/**
 * True only when the value was actually handed to storage. A write can fail
 * while reads and deletes still work — Safari private mode and ITP storage
 * limits throw on `setItem`, a browser at quota throws `QuotaExceededError`,
 * and a blocked third-party context throws on `localStorage` access itself.
 * Callers that supersede data must treat `false` as "nothing was stored",
 * never as success.
 */
const writeItem = (key: string, value: string): boolean => {
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

const removeItem = (key: string): void => {
  try {
    storage()?.removeItem(key);
  } catch {
    // storage unavailable — nothing persisted to forget
  }
};

const shorten = (address: string): string =>
  address.length > 26 ? `${address.slice(0, 14)}…${address.slice(-10)}` : address;

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

/**
 * Supersedes any legacy bare keys with the single versioned record.
 *
 * The delete is strictly ordered after the write and runs ONLY once the write
 * actually landed. Deleting first (or unconditionally) destroys the one and
 * only copy of a real, already-deployed event address whenever the v1 write is
 * refused, leaving `readActiveEventRecord()` to report `undefined` and
 * `requireVerifiedActiveEvent` to blame a wallet that has no event configured —
 * pushing the user to pay for a second deployment of an event they already own.
 * Keeping the legacy keys costs nothing: they stay fail-closed `unverified`
 * until a later write supersedes them, and only an explicit
 * {@link forgetActiveEvent} removes them on purpose.
 *
 * @returns true only when the superseding write actually landed in storage.
 */
const writeRecord = (record: ActiveEventRecord): boolean => {
  const written = writeItem(ACTIVE_EVENT_KEY, JSON.stringify({ v: 1, ...record }));
  if (!written) return false;
  // Any legacy bare keys are superseded; remove them so there is exactly one
  // source of truth and no stale value can be mistaken for a verified event.
  removeItem(LEGACY_ADDRESS_KEY);
  removeItem(LEGACY_ORGANIZER_KEY);
  return true;
};

const migrateLegacy = (): ActiveEventRecord | undefined => {
  const address = readItem(LEGACY_ADDRESS_KEY);
  if (!address) return undefined;
  if (!isValidContractAddress(address)) {
    // An unusable value is safe to drop; there is no event behind it.
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
  // If the v1 write is refused, writeRecord leaves the legacy keys in place, so
  // this address survives and a later read can retry instead of being orphaned.
  writeRecord(migrated);
  return migrated;
};

/**
 * The record this page session produced, held only in memory.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `localStorage.setItem` is NOT atomic with respect to being available, and a
 * deployment that finalized on-chain CANNOT be repeated for free. The failure
 * this guards is the exact one reported from production:
 *
 *   1. The organizer identity is resolved, the event is deployed on-chain, and
 *      its `organizer` cell is read back and matched — a genuinely owned,
 *      genuinely usable event now exists.
 *   2. `recordVerifiedActiveEvent` writes the record and returns it, so the
 *      caller reports success.
 *   3. The write is refused (private/incognito window, ITP storage limit,
 *      quota exhausted, storage access blocked). Nothing is stored.
 *   4. Every later read goes back to storage, finds nothing, and
 *      `requireVerifiedActiveEvent` reports "No event contract address
 *      configured. Click 'Deploy a new wallet-backed event'" — for a wallet
 *      that owns a live event, whose address has just been orphaned and whose
 *      organizer key cannot be re-derived (`signData` is non-deterministic).
 *
 * A verified record is therefore also kept in memory for the lifetime of the
 * page, so a refused write costs the user nothing for the session they are in.
 *
 * ── Why this is not a hole in the verification gate ─────────────────────────
 *
 * The mirror can only ever hold a record that these functions produced, and the
 * only way to produce a `verified` one is {@link recordVerifiedActiveEvent} —
 * which is reached exclusively after an on-chain `organizer` comparison
 * succeeded. It can never invent authority, promote an unverified deployment, or
 * resurrect an address that was invalidated. It is not persisted, so it cannot
 * outlive the tab, and it is cleared by {@link forgetActiveEvent}.
 *
 * It is also never allowed to ADD authority over a stored record: see
 * {@link readActiveEventRecord}, which spells out the single exception it is
 * allowed.
 */
let sessionRecord: ActiveEventRecord | undefined;

/**
 * How much authority a status carries, so two records can be compared.
 *
 * This exists for exactly one decision — which record wins when storage and the
 * in-session mirror disagree — and it is ordered so that comparing two records
 * can only ever fail CLOSED. `verified` is the most authority an event can
 * carry, a deployment whose organizer was never checked has less, and an event
 * that was rejected has none.
 */
const authorityRank = (status: ActiveEventStatus): number =>
  status === 'verified' ? 2 : status === 'unverified' ? 1 : 0;

/**
 * The current active event: what storage holds — except where this page has
 * itself proved that record is no longer usable.
 *
 * Storage is the source of truth and is believed on its own, including when it
 * says `verified`: an event another session stored is never silently swapped out
 * from under the actions reading it, and a leftover legacy bare address is
 * fail-closed `unverified` and therefore never usable, so it is never authority
 * over a record this page established.
 *
 * There is exactly ONE thing storage cannot be believed about: a status this
 * page has already moved past. A refused write must never be a licence to keep
 * acting on an event this wallet does not own, so a mirror record with LESS
 * authority than the stored one wins for the rest of the page. Without that,
 * `invalidateActiveEvent` on a quota-exhausted browser would keep reporting
 * `verified`, and `requireVerifiedActiveEvent` would keep handing the app an
 * address it had just rejected. The mirror can still never add authority over a
 * stored record, so the comparison fails closed in both directions:
 *
 *   - a tampered or unparseable stored record is ignored outright, never
 *     repaired from memory and never promoted to `verified`;
 *   - an `invalidated` stored record stays unusable, so a rejected address is
 *     never resurrected from memory;
 *   - a refused write while an older verified event is still stored leaves that
 *     older event in place, rather than activating an address this browser
 *     cannot record;
 *   - where storage holds no versioned record at all, the mirror gap-fills,
 *     which is the refused-write case this file exists to survive.
 */
export const readActiveEventRecord = (): ActiveEventRecord | undefined => {
  const rawStored = readItem(ACTIVE_EVENT_KEY);
  if (rawStored !== undefined) {
    const stored = parseRecord(rawStored);
    // A tampered or unparseable value is ignored, never repaired from memory.
    if (!stored) return undefined;
    if (sessionRecord && authorityRank(sessionRecord.status) < authorityRank(stored.status)) return sessionRecord;
    return stored;
  }
  // Also retries a pending legacy migration, which supersedes the legacy keys as
  // soon as writes are accepted again.
  const legacy = migrateLegacy();
  if (sessionRecord) return sessionRecord;
  return legacy;
};

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
  sessionRecord = record;
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
  sessionRecord = record;
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
  // An invalidated event is never usable, so it also must not stay usable
  // through the in-session record if its write to storage is refused.
  sessionRecord = record;
  writeRecord(record);
  return record;
};

/** Explicit, user-requested removal. Never called from an error path. */
export const forgetActiveEvent = (): void => {
  sessionRecord = undefined;
  removeItem(ACTIVE_EVENT_KEY);
  removeItem(LEGACY_ADDRESS_KEY);
  removeItem(LEGACY_ORGANIZER_KEY);
};

/**
 * Drops the in-memory session record ONLY, leaving storage untouched.
 *
 * The mirror is page-lifetime state, so a test file that drives many scenarios
 * against one imported module instance would otherwise let a record established
 * by an earlier test leak into a later one that expects a clean slate. Production
 * code never calls this: the only real-world clear is the user-requested
 * {@link forgetActiveEvent}, which also removes the persisted record.
 */
export const resetActiveEventSession = (): void => {
  sessionRecord = undefined;
};

/**
 * True when the active event is durably stored, i.e. it survives a reload.
 *
 * False means the browser refused the write: the event is real and verified,
 * and usable for as long as this page stays open, but a refresh would lose it.
 * The UI must say so rather than implying the event is safely remembered.
 */
export const isActiveEventDurable = (): boolean => {
  const current = readActiveEventRecord();
  if (!current) return false;
  const stored = parseRecord(readItem(ACTIVE_EVENT_KEY));
  return stored?.address === current.address && stored?.status === current.status;
};

/**
 * Truthful wording for a verified event this browser could not store.
 *
 * It states the two facts the user needs — the event IS on-chain and owned by
 * this wallet, and the address will be lost on refresh — instead of letting the
 * app claim a successful, remembered configuration it does not have.
 */
export const activeEventNotPersistedMessage = (address: string): string =>
  `This browser refused to save event ${shorten(address)}, so it is active for this page only and will be ` +
  `forgotten on refresh. The event itself is on-chain and its organizer was verified — nothing needs to be ` +
  `deployed again now, but this browser cannot remember it. Allow site storage for this app (and avoid ` +
  `private/incognito windows or a full disk), then reload and deploy once more if you need the event to ` +
  `survive a refresh.`;

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

/**
 * True when the WALLET refused a request because it already has a transaction
 * waiting to be confirmed.
 *
 * The 1AM wallet accepts one pending transaction at a time, so this is what a
 * second concurrent submission looks like. It is not a contract failure, not an
 * authorization failure, and not something a retry fixes on its own — the
 * pending transaction has to confirm or expire first.
 *
 * It lives here, beside {@link isStaleContractBuildError}, because both exist
 * for the same reason: the UI must recognise an SDK/wallet error it did not
 * author and explain it truthfully instead of printing a raw message.
 */
export const isTransactionPendingError = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const { message } = err as { message?: unknown };
  return typeof message === 'string' && /a transaction is already pending/i.test(message);
};

/**
 * Truthful explanation of a transaction the wallet declined to accept.
 *
 * Says what was refused and what it means — nothing was issued, nothing changed
 * on the event — and gives the one action that can actually clear it. It never
 * implies the request succeeded and never suggests retrying into the same wall.
 */
export const transactionPendingMessage = (): string =>
  `The 1AM wallet already has a transaction waiting to be confirmed, so it refused this one. Nothing was issued and ` +
  `nothing was changed on the event. Wait for the pending transaction to be included on-chain (or to expire), then ` +
  `try again. This wallet accepts one transaction at a time, so "Issue credential" and "Verify access" cannot be ` +
  `run at the same time.`;

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
