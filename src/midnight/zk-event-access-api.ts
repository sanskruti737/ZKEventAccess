import * as ZKEventAccess from '../../managed/zk-event-access/contract/index.js';
import {
  CompactTypeBytes,
  CompactTypeVector,
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
  persistentHash,
} from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  deployContract,
  findDeployedContract,
  type FoundContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import { combineLatest, firstValueFrom, from, map, type Observable } from 'rxjs';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { witnesses, type ZKEventAccessPrivateState } from '../witnesses.js';
import type { Logger } from './logger';
import { FOREIGN_ORGANIZER_HEADLINE } from './active-event';

export const ZK_EVENT_ACCESS_PRIVATE_STATE_ID = 'counterPrivateState';

export type ZKEventAccessCircuitKeys = Exclude<keyof ZKEventAccess.Contract['impureCircuits'], number | symbol>;

export type ZKEventAccessContract = ZKEventAccess.Contract<ZKEventAccessPrivateState, ZKEventAccess.Witnesses<ZKEventAccessPrivateState>>;

/**
 * Wallet-owned organizer identity capability.
 *
 * The organizer secret key is derived from the connected 1AM wallet via its
 * `signData` capability over a fixed domain message, then persisted in the
 * wallet-scoped private state provider (IndexedDB) so it survives a page
 * refresh. The key is never stored in localStorage/sessionStorage, never
 * pasted or generated at random, never appears in the UI, logs, or network
 * requests: it is materialized from the wallet exactly once and recovered from
 * the private state provider on every later session of that same wallet.
 */
export interface OrganizerIdentity {
  readonly deriveOrganizerSecretKey: () => Promise<Uint8Array>;
}

export type ZKEventAccessProviders = MidnightProviders<
  ZKEventAccessCircuitKeys,
  typeof ZK_EVENT_ACCESS_PRIVATE_STATE_ID,
  ZKEventAccessPrivateState
> & {
  readonly organizerIdentity?: OrganizerIdentity;
};

/** The contract binding with our witnesses attached; key material comes from the zkConfigProvider at runtime. */
export const CompiledZKEventAccessContract = CompiledContract.make<ZKEventAccess.Contract<ZKEventAccessPrivateState>>(
  'zk-event-access',
  ZKEventAccess.Contract,
).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets('./managed/zk-event-access'),
);

export interface ZKEventAccessLedgerState {
  /** Current public credential count. */
  readonly counter: bigint;
  readonly announcement: string;
  /** Hex of the on-chain registered organizer commitment (public data). */
  readonly organizer: string;
}

const ORGANIZER_DOMAIN = new Uint8Array([
  122, 107, 69, 118, 101, 110, 116, 65, 99, 99, 101, 115, 115, 58, 111, 114, 103, 97, 110, 105, 122, 101, 114, 0, 0,
  0, 0, 0, 0, 0, 0, 0,
]);

/**
 * The value the contract writes into its `contractAddress` ledger cell at
 * construction time: `disclose(kernel.self().bytes)`.
 *
 * A contract's own address DOES NOT EXIST while its constructor runs. The
 * generated contract builds its constructor context with
 * `createCircuitContext(dummyContractAddress(), ...)`, and the deploy tx is then
 * built from the FINISHED initial state:
 *
 *   const contractDeploy = new ContractDeploy(toLedgerContractState(contractState));
 *   // ledger-v8: "Creates a deployment for an arbitrary contract state.
 *   //              The deployment and its address are randomised."
 *
 * so the (randomised) address is generated only AFTER the constructor has run.
 * `kernel.self().bytes` is therefore always `dummyContractAddress()`, which is 32
 * zero bytes — never the address the event ends up at.
 *
 * This is what the previous organizer bug was: hashing the deployed address in
 * this position produced a value that can never equal the ledger's `organizer`,
 * so the post-deploy check reported a mismatch for every event, forever.
 *
 * ── Documented reliance on zero-address padding ──────────────────────────────
 *
 * In `@midnight-ntwrk/onchain-runtime-v3@3.0.0`, `dummyContractAddress()` is a
 * 64-character hex STRING ("0000…0000"), not a `Uint8Array`. The `as unknown as
 * Uint8Array` cast above is therefore a lie at runtime: `new Uint8Array(<string>)`
 * goes through the TypedArray numeric conversion and yields a ZERO-LENGTH array,
 * not 32 zero bytes.
 *
 * That is harmless ONLY because the element is hashed inside
 * `persistentHash<Vector<3, Bytes<32>>>`, whose `CompactTypeBytes(32)` element
 * type pads it back to 32 zero bytes — byte-for-byte what the contract's
 * constructor hashed. So this constant is the zero address, is never a deployed
 * address, and the commitment it produces is correct.
 *
 * It is exported, and its exact behaviour is pinned by the regression tests in
 * tests/organizer-commitment.test.ts ("CONSTRUCTION_ADDRESS_PLACEHOLDER"), so a
 * future SDK that stopped padding — or that returned a non-zero dummy address —
 * fails there loudly instead of silently producing an unverifiable commitment.
 */
export const CONSTRUCTION_ADDRESS_PLACEHOLDER = new Uint8Array(dummyContractAddress() as unknown as Uint8Array);


/**
 * Off-chain mirror of the contract's `publicKey` circuit.
 *
 * MUST stay byte-for-byte equivalent to `contracts/zk-event-access.compact`:
 *
 *   circuit publicKey(sk: Bytes<32>): Bytes<32> {
 *     return persistentHash<Vector<3, Bytes<32>>>(
 *       [pad(32, "zkEventAccess:organizer"), contractAddress, sk]);
 *   }
 *
 * where `contractAddress` is the LEDGER value written by the constructor, i.e.
 * {@link CONSTRUCTION_ADDRESS_PLACEHOLDER}. Substituting the real deployed
 * address here (or dropping the element to a `Vector<2>`) yields a value that
 * can never equal the ledger's `organizer`.
 */
export const organizerCommitment = (secretKey: Uint8Array): string =>
  toHex(
    new Uint8Array(
      persistentHash(new CompactTypeVector(3, new CompactTypeBytes(32)), [
        ORGANIZER_DOMAIN,
        CONSTRUCTION_ADDRESS_PLACEHOLDER,
        secretKey,
      ]),
    ),
  );

/**
 * The organizer commitment the contract's OWN constructor puts on-chain for a
 * given organizer secret key — derived by EXECUTING the compiled contract
 * (`managed/zk-event-access/contract/index.js`), not by re-implementing the
 * formula here.
 *
 * This is the single source of truth for "what would this wallet's key produce
 * on-chain". The TypeScript mirror {@link organizerCommitment} above is only a
 * human-readable restatement of that formula and is pinned to this function by
 * the tests in tests/organizer-commitment.test.ts, so the two can never drift
 * apart silently.
 *
 * Why this exists: the mirror is a hand-written copy of
 *
 *   circuit publicKey(sk: Bytes<32>): Bytes<32> {
 *     return persistentHash<Vector<3, Bytes<32>>>(
 *       [pad(32, "zkEventAccess:organizer"), contractAddress, sk]);
 *   }
 *
 * and every historical copy of it in this repository's history disagreed with
 * the compiled contract — one omitted the address element entirely
 * (`Vector<2>`), the next hashed the REAL DEPLOYED ADDRESS where the contract
 * hashes the value the constructor wrote into its own `contractAddress` cell
 * (32 zero bytes, because a contract has no address while its constructor runs).
 * Each of those produced a post-deployment "organizer does not match" failure
 * for every event, forever, with no way to recover it. Deriving the expectation
 * from the artifact removes that entire class of bug: the value compared against
 * the chain is now produced by the same code the chain's constructor runs.
 *
 * The constructor context is built with a fixed zero address and zero coin
 * public key rather than the wallet's. That is deliberate and not a shortcut:
 * the compiler resolves `kernel.self().bytes` to 32 zero bytes (see the
 * generated `new Uint8Array(32)` in managed/zk-event-access/contract/index.js),
 * and the `organizer` cell is `publicKey(sk)`, which hashes only the domain,
 * that cell, and `sk`. So neither the circuit-context address nor the coin
 * public key can change the result — pinned by "does not depend on the coin
 * public key" and "is independent of the circuit context address" in
 * tests/organizer-commitment.test.ts. Using fixed values also keeps
 * verification independent of wallet-reported key formats.
 */
export const constructorOrganizerCommitment = (secretKey: Uint8Array): string => {
  const contract = new ZKEventAccess.Contract<
    ZKEventAccessPrivateState,
    ZKEventAccess.Witnesses<ZKEventAccessPrivateState>
  >(witnesses);
  // 32 zero bytes, as the hex string `createConstructorContext` accepts. The
  // constructor's organizer cell does not depend on it (pinned by tests).
  const initial = contract.initialState(
    createConstructorContext({ organizerSecretKey: secretKey }, '00'.repeat(32)),
  );
  const context = createCircuitContext(
    dummyContractAddress() as unknown as ContractAddress,
    initial.currentZswapLocalState,
    initial.currentContractState,
    initial.currentPrivateState,
  );
  return toHex(ZKEventAccess.ledger(context.currentQueryContext.state).organizer);
};

const DEPLOY_TIMEOUT_MS = 5 * 60_000;
const DEPLOY_STATE_READ_TIMEOUT_MS = 60_000;

const withTimeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, watcher]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Hex digests of organizer keys this wallet has genuinely provisioned. With a
 * persistent (IndexedDB) private-state provider, the gate for "is this a real
 * organizer key?" is simply: a 32-byte non-zero value at `ZK_EVENT_ACCESS_PRIVATE_STATE_ID`.
 * The read-only join placeholder (`new Uint8Array(32)`, all zeros) can therefore
 * never be mistaken for organizer authority.
 */
const isZeroKey = (key: Uint8Array): boolean => {
  for (const b of key) {
    if (b !== 0) return false;
  }
  return true;
};

/**
 * Resolves the organizer secret key (proof witness) from the wallet-bound,
 * persistent private state provider, under `ZK_EVENT_ACCESS_PRIVATE_STATE_ID`. It is
 * never read from or written to localStorage or sessionStorage, and never
 * reaches the UI, `window`, or the network.
 *
 * Because the wallet's `signData` is non-deterministic, the organizer key
 * cannot be reproduced by re-deriving it after a refresh — it survives only
 * because the private-state provider persists it (IndexedDB), scoped to this
 * wallet. Any 32-byte non-zero key stored there was written by this wallet's
 * own derivation/deployment path in a prior session and is accepted as its
 * organizer identity. Otherwise `null` is returned so callers can decide to
 * derive the wallet-owned key rather than fabricating one.
 */
const resolveOrganizerSecretKey = async (providers: ZKEventAccessProviders): Promise<Uint8Array | null> => {
  try {
    const state = (await providers.privateStateProvider.get(ZK_EVENT_ACCESS_PRIVATE_STATE_ID)) as
      | ZKEventAccessPrivateState
      | null;
    const key = state?.organizerSecretKey;
    if (key && key.length === 32 && !isZeroKey(key)) {
      return key;
    }
  } catch {
    // fall through: no organizer identity is available for this wallet
  }
  return null;
};

/**
 * In-flight derivation promise for the wallet-owned organizer key.
 *
 * Without this single-flight guard, ANY number of concurrent callers that find
 * no cached session key would each call `api.signData(...)` — and the 1AM
 * wallet answers concurrent identical signing requests with "Duplicate request
 * — a similar request is already pending". This guards the ONLY place that
 * turns wallet signData into the organizer key, so N concurrent callers share
 * exactly ONE wallet request, and the request is released (nulled) once the
 * promise settles — success or failure — so a later click starts a fresh one.
 */
let organizerKeyDerivation: Promise<Uint8Array> | null = null;

const deriveWalletOrganizerKey = (providers: ZKEventAccessProviders): Promise<Uint8Array> => {
  if (!providers.organizerIdentity) {
    return Promise.reject(
      new Error(
        'Organizer authorization failed: the connected 1AM wallet does not expose a wallet-owned organizer identity, ' +
          'so it cannot issue credentials. Only the wallet that owns the event organizer identity can increment.',
      ),
    );
  }
  if (!organizerKeyDerivation) {
    organizerKeyDerivation = providers.organizerIdentity
      .deriveOrganizerSecretKey()
      .then((derived) => {
        if (derived.length !== 32) {
          throw new Error('Organizer authorization failed: the 1AM wallet produced an invalid organizer key length.');
        }
        return derived;
      })
      .finally(() => {
        organizerKeyDerivation = null;
      });
  }
  return organizerKeyDerivation;
};

/**
 * Where a resolved organizer identity came from. Reported for diagnostics only —
 * all three produce the same key and the same commitment.
 *
 * - `persisted`: recovered from the wallet-scoped private state provider, i.e. this
 *   wallet provisioned it in an earlier session.
 * - `session`:   already resolved earlier in THIS page session (see
 *   {@link sessionOrganizerIdentities}).
 * - `wallet`:    derived from the connected 1AM wallet just now.
 */
export type OrganizerIdentitySource = 'persisted' | 'session' | 'wallet';

/** The one true answer to "who is the organizer for this wallet right now". */
export interface OrganizerIdentityResolution {
  /** The 32-byte proof witness. Never logged, never leaves the wallet. */
  readonly secretKey: Uint8Array;
  /** Exactly what the contract's constructor will put on-chain for this key. */
  readonly commitment: string;
  readonly source: OrganizerIdentitySource;
}

/**
 * Organizer identities already resolved in this page session, keyed by the
 * private-state provider object — which is constructed per connected wallet
 * (src/midnight/providers.ts), so one wallet can never read another's identity and
 * switching wallets resolves a fresh one.
 *
 * This exists because the wallet's `signData` is NON-DETERMINISTIC: deriving twice
 * yields two different keys, hence two different commitments. Any second resolution
 * after a key was already resolved would compare the chain against an identity the
 * chain never saw, and report a mismatch for a perfectly valid deployment. The
 * persisted private state remains the source of truth across sessions; this only
 * pins the identity for the lifetime of one page session, where re-deriving is
 * meaningless because the result would be a different organizer.
 */
const sessionOrganizerIdentities = new WeakMap<object, OrganizerIdentityResolution>();

const sameSecretKey = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * Writes the wallet-derived key to the private state provider and READS IT BACK.
 *
 * The key is the only durable proof that this browser owns the event: `signData`
 * cannot reproduce it, so a key that fails to persist is lost forever and the event
 * it deployed becomes permanently un-issuable from this wallet. Rather than deploy an
 * event that can never be issued against, this refuses — loudly, and before any
 * transaction is built.
 */
const persistOrganizerSecretKey = async (providers: ZKEventAccessProviders, secretKey: Uint8Array): Promise<void> => {
  try {
    await providers.privateStateProvider.set(ZK_EVENT_ACCESS_PRIVATE_STATE_ID, { organizerSecretKey: secretKey });
  } catch (err) {
    throw new OrganizerKeyPersistenceError(err instanceof Error ? err.message : String(err));
  }
  const readBack = await resolveOrganizerSecretKey(providers);
  if (!readBack || !sameSecretKey(readBack, secretKey)) {
    throw new OrganizerKeyPersistenceError('the private state provider did not return the key that was just written');
  }
};

/**
 * Resolves this wallet's organizer identity — the single entry point for "which
 * commitment should the chain have?", used by the deploy flow, the post-deploy
 * verification and the pre-flight issue check alike, so all three are guaranteed to
 * be talking about the SAME organizer.
 *
 * Order: the persisted key wins (it is what previous events were deployed with),
 * then this session's already-resolved identity, and only then a fresh derivation
 * from the connected 1AM wallet — which is single-flight (see
 * {@link deriveWalletOrganizerKey}) and must persist successfully.
 *
 * There is no random-key fallback and no way to supply a key from outside: the key
 * comes from the wallet or from this wallet's own persisted private state, nothing
 * else.
 */
export const resolveOrganizerIdentity = async (
  providers: ZKEventAccessProviders,
): Promise<OrganizerIdentityResolution> => {
  const scope: object = providers.privateStateProvider;

  const persisted = await resolveOrganizerSecretKey(providers);
  if (persisted) {
    const resolution: OrganizerIdentityResolution = {
      secretKey: persisted,
      commitment: constructorOrganizerCommitment(persisted),
      source: 'persisted',
    };
    sessionOrganizerIdentities.set(scope, resolution);
    return resolution;
  }

  const alreadyResolved = sessionOrganizerIdentities.get(scope);
  if (alreadyResolved) return { ...alreadyResolved, source: 'session' };

  const derived = await deriveWalletOrganizerKey(providers);
  await persistOrganizerSecretKey(providers, derived);
  const resolution: OrganizerIdentityResolution = {
    secretKey: derived,
    commitment: constructorOrganizerCommitment(derived),
    source: 'wallet',
  };
  sessionOrganizerIdentities.set(scope, resolution);
  return resolution;
};

/**
 * The organizer witness key for the current session, resolved exactly once per
 * connected wallet (see {@link resolveOrganizerIdentity}).
 */
const resolveOrDeriveOrganizerSecretKey = async (providers: ZKEventAccessProviders): Promise<Uint8Array> =>
  (await resolveOrganizerIdentity(providers)).secretKey;

/** A joined instance of the ZK Event Access contract. */
export class ZKEventAccessAPI {
  private constructor(
    public readonly deployed: FoundContract<ZKEventAccessContract>,
    providers: ZKEventAccessProviders,
    private readonly logger?: Logger,
  ) {
    this.providers = providers;
    this.contractAddress = deployed.deployTxData.public.contractAddress;
    providers.privateStateProvider.setContractAddress(this.contractAddress);

    this.state$ = combineLatest([
      providers.publicDataProvider.contractStateObservable(this.contractAddress, { type: 'latest' }).pipe(
        map((contractState) => {
          const ledger = ZKEventAccess.ledger(contractState.data);
          return {
            counter: ledger.counter,
            announcement: ledger.announcement,
            organizer: toHex(ledger.organizer),
          } satisfies ZKEventAccessLedgerState;
        }),
      ),
      from(providers.privateStateProvider.get(ZK_EVENT_ACCESS_PRIVATE_STATE_ID) as Promise<ZKEventAccessPrivateState | null>),
    ]).pipe(map(([ledger]) => ledger));
  }

  readonly contractAddress: ContractAddress;
  readonly state$: Observable<ZKEventAccessLedgerState>;
  private readonly providers: ZKEventAccessProviders;

  /**
   * Issues one access credential (organizer-only circuit).
   *
   * The organizer witness key is resolved from the wallet-bound private state
   * provider (persisted organizer key, recovered across sessions) and used to
   * build a local proof. The on-chain organizer assert remains the final gate —
   * if the connected wallet is not the registered organizer, the chain rejects
   * the call and the error is surfaced truthfully.
   */
  async increment(): Promise<void> {
    await resolveOrDeriveOrganizerSecretKey(this.providers);
    this.logger?.info('increment: proving locally...');
    const txData = await this.deployed.callTx.increment();
    this.logger?.info({ txHash: txData.public.txHash }, 'increment finalized');
  }

  /**
   * Returns the organizer commitment the connected wallet would register if it
   * deployed an event. Resolved through {@link resolveOrganizerIdentity}, so it is
   * the same identity the deploy flow uses — never a second, independent derivation
   * that could differ because the wallet's `signData` is non-deterministic.
   */
  static async currentOrganizerCommitment(providers: ZKEventAccessProviders): Promise<string> {
    return (await resolveOrganizerIdentity(providers)).commitment;
  }

  /**
   * One-shot read of the current on-chain ledger state for this event. Used to
   * refresh the public credential count immediately after a finalized issuance,
   * independent of the state$ poll cadence.
   */
  async readLatest(): Promise<ZKEventAccessLedgerState> {
    const contractState = await this.providers.publicDataProvider.queryContractState(this.contractAddress);
    if (!contractState) {
      throw new Error('Could not read the current on-chain state for this event.');
    }
    const ledger = ZKEventAccess.ledger(contractState.data);
    return {
      counter: ledger.counter,
      announcement: ledger.announcement,
      organizer: toHex(ledger.organizer),
    };
  }

  /**
   * Joins the preprod contract. The private state provider holds this wallet's
   * organizer secret key (persisted across sessions, scoped to this wallet).
   *
   * The join deliberately passes `privateStateId` WITHOUT `initialPrivateState`,
   * which is the SDK's non-destructive form: `findDeployedContract` then READS
   * the state already stored under that id and fails with a clear error if there
   * is none. Passing `initialPrivateState` would instead WRITE it — and the
   * previous code supplied `new Uint8Array(32)` whenever the key could not be
   * read at that instant, permanently overwriting the wallet's real organizer
   * key with 32 zero bytes. `signData` is non-deterministic, so that key cannot
   * be re-derived: the event would have been left un-issuable forever and every
   * later identity resolution would disagree with the chain, surfacing as an
   * unexplainable "organizer does not match" on an event that is visibly this
   * wallet's own. A missing key is now reported, never replaced.
   */
  static async join(providers: ZKEventAccessProviders, contractAddress: ContractAddress, logger?: Logger): Promise<ZKEventAccessAPI> {
    logger?.info({ joinContract: { contractAddress } }, 'joining deployed ZK Event Access contract');

    const organizerSecretKey = await resolveOrganizerSecretKey(providers);
    if (!organizerSecretKey) {
      throw new OrganizerIdentityUnavailableError(String(contractAddress));
    }

    const deployed = await findDeployedContract<ZKEventAccessContract>(providers, {
      contractAddress,
      compiledContract: CompiledZKEventAccessContract,
      privateStateId: ZK_EVENT_ACCESS_PRIVATE_STATE_ID,
    });

    return new ZKEventAccessAPI(deployed, providers, logger);
  }

  /**
   * Outcome of comparing an event's on-chain `organizer` cell with the connected
   * wallet's derived identity, using the SAME canonical formula on both sides
   * (see {@link organizerCommitment}).
   */
  static async verifyOrganizer(
    api: ZKEventAccessAPI,
    providers: ZKEventAccessProviders,
  ): Promise<{ readonly address: string; readonly onChain: string; readonly expected: string; readonly verified: boolean }> {
    const address = String(api.contractAddress);
    const [{ organizer }, expected] = await Promise.all([api.readLatest(), this.currentOrganizerCommitment(providers)]);
    return { address, onChain: organizer, expected, verified: organizer.toLowerCase() === expected.toLowerCase() };
  }

  /**
   * Deploys a NEW event instance whose organizer identity is owned by the
   * connected 1AM wallet. The organizer key is derived from the wallet (never
   * generated at random), persisted in the wallet-scoped private state provider
   * so it survives refreshes, and the on-chain `organizer` commitment is bound
   * to it — so every future session of that same wallet recovers the key from
   * the private state provider and can issue credentials without any secret
   * leaving the wallet's key material.
   *
   * The returned API is ONLY safe to activate after
   * {@link ZKEventAccessAPI.verifyOrganizer} has confirmed the on-chain
   * `organizer` cell equals this wallet's derived identity. `onDeploymentFinalized`
   * fires as soon as the deploy transaction is on-chain, so the caller can
   * remember the address (and never lose it) — but remembering it is NOT
   * activation, and the caller must record it as unverified until the
   * comparison below succeeds.
   *
   * On a verification failure this throws an {@link OrganizerVerificationError}
   * carrying BOTH values, and never asks for another deployment: the caller
   * shows the exact mismatch and stops.
   *
   * The returned `organizerCommitment` is the exact value this deployment was
   * built from AND verified against on-chain. Callers must compare the on-chain
   * cell against THAT value rather than resolving the wallet identity a second
   * time: the wallet's `signData` is non-deterministic, so a second resolution can
   * yield a different key and a spurious mismatch for a correct deployment.
   */
  static async deployNew(
    providers: ZKEventAccessProviders,
    logger?: Logger,
    onDeploymentFinalized?: (address: string) => void,
  ): Promise<{ readonly api: ZKEventAccessAPI; readonly organizerCommitment: string }> {
    logger?.info('deploying new ZK Event Access contract instance');
    const identity = await resolveOrganizerIdentity(providers);
    const organizerSecretKey = identity.secretKey;

    const deployed = await withTimeout(
      deployContract(providers, {
        compiledContract: CompiledZKEventAccessContract,
        privateStateId: ZK_EVENT_ACCESS_PRIVATE_STATE_ID,
        initialPrivateState: { organizerSecretKey },
      }),
      DEPLOY_TIMEOUT_MS,
      `Deployment timed out: the deployment transaction was submitted to the 1AM wallet but no new event ` +
        `appeared on-chain within ${DEPLOY_TIMEOUT_MS / 60000} minutes. Check that you approved it in the wallet ` +
        `and that the wallet has preprod coins for the deployment fee, then retry.`,
    );
    const deployedAddress = String(deployed.deployTxData.public.contractAddress);
    // Expected value comes from executing the compiled contract's own
    // constructor with the very key this deploy was built from, so it cannot
    // disagree with the on-chain `organizer` cell the way a hand-copied formula
    // can — and it is the SAME resolution the constructor was given, not a fresh
    // one, so the chain and this expectation can never describe two organizers.
    const expectedOrganizer = identity.commitment;
    console.log('[deploy] wallet-derived organizer commitment:', expectedOrganizer);
    // The deployment transaction is finalized on-chain at this point, so the
    // real address is a fact — publish it immediately so the caller can record
    // it as UNVERIFIED even if the verification read below times out on a
    // lagging indexer. This callback must never be treated as "activated".
    onDeploymentFinalized?.(deployedAddress);
    console.log('[deploy] new event on-chain:', deployedAddress, '— reading its organizer for verification...');

    const api = new ZKEventAccessAPI(deployed, providers, logger);
    let onChainOrganizer: string;
    try {
      ({ organizer: onChainOrganizer } = await withTimeout(
        firstValueFrom(api.state$),
        DEPLOY_STATE_READ_TIMEOUT_MS,
        `The new event (${deployedAddress}) is on-chain, but its state could not be read from the indexer within ` +
          `${DEPLOY_STATE_READ_TIMEOUT_MS / 1000} seconds, so its organizer could not be verified.`,
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The error states the "not activated" consequence itself; this call site
      // only supplies what went wrong.
      throw new OrganizerUnverifiedError(deployedAddress, expectedOrganizer, undefined, message);
    }

    if (onChainOrganizer.toLowerCase() !== expectedOrganizer.toLowerCase()) {
      throw new OrganizerVerificationError(deployedAddress, onChainOrganizer, expectedOrganizer);
    }
    console.log('[deploy] organizer verified on-chain:', onChainOrganizer);
    logger?.info({ deployedAddress, organizer: onChainOrganizer }, 'deploy verified: connected 1AM wallet is the on-chain organizer');
    return { api, organizerCommitment: expectedOrganizer };
  }
}

/**
 * The new event is on-chain, but its organizer has not been proven to be the
 * connected wallet. The event is NOT active and nothing may be issued on it.
 *
 * The "not activated" consequence is stated here, in the error itself, rather
 * than left to each call site: this error is the only signal a caller gets that
 * a finalized deployment did NOT become the active event, so a bare cause
 * message (an indexer read timeout, for instance) must never be shown on its
 * own — it would read as "deployed, but something minor went wrong" and invite a
 * retry against an event that cannot issue.
 */
export class OrganizerUnverifiedError extends Error {
  constructor(
    readonly address: string,
    readonly expected: string,
    readonly onChain: string | undefined,
    detail: string,
  ) {
    super(
      `${detail} The event ${address} is on-chain but is NOT active: it was not activated because its ` +
        `on-chain organizer could not be read back and matched against the connected 1AM wallet ` +
        `(expected organizer commitment ${expected}), so nothing can be issued on it. Click "Deploy a new ` +
        `wallet-backed event" to deploy and verify one.`,
    );
    this.name = 'OrganizerUnverifiedError';
  }
}

/**
 * The new event is on-chain but its organizer commitment does not match the
 * connected 1AM wallet. Both values are carried so the UI can show the exact
 * mismatch instead of a generic failure.
 */
export class OrganizerVerificationError extends Error {
  constructor(
    readonly address: string,
    readonly onChain: string,
    readonly expected: string,
  ) {
    super(
      `Deployment verification failed: the new event ${address} was created on-chain, but its organizer ` +
        `commitment ${onChain} does not match the connected 1AM wallet's identity ${expected}. ` +
        `${FOREIGN_ORGANIZER_HEADLINE} Nothing was issued and the event was NOT activated.`,
    );
    this.name = 'OrganizerVerificationError';
  }
}

/**
 * The organizer key derived from the connected 1AM wallet could not be persisted
 * to the wallet-scoped private state provider.
 *
 * This aborts BEFORE any deployment transaction is built, on purpose. The wallet's
 * `signData` is non-deterministic, so a key that is not persisted cannot be
 * reproduced: an event deployed with it could be issued against in this tab and
 * never again, and the mismatch would surface later as an unexplainable
 * "organizer does not match" on an event that is visibly this wallet's own. No
 * deployment is attempted, and nothing is faked to work around it — the fix is a
 * browser that can store the key (not private/incognito mode, no storage pressure).
 */
export class OrganizerKeyPersistenceError extends Error {
  constructor(detail: string) {
    super(
      `Organizer authorization could not be secured: the key derived from the connected 1AM wallet could not be ` +
        `saved to this wallet's private state (${detail}). That key cannot be regenerated later — the 1AM wallet's ` +
        `signature is not reproducible — so no event was deployed, because an event deployed now could never be ` +
        `issued against again. Allow site storage for this app (and avoid private/incognito windows), then retry.`,
    );
    this.name = 'OrganizerKeyPersistenceError';
  }
}

/**
 * The active event's organizer key is no longer in this wallet's private state.
 *
 * The key is the only durable proof of ownership and `signData` cannot reproduce
 * it, so a join that cannot find it MUST NOT invent one: the previous code
 * substituted 32 zero bytes and `findDeployedContract` wrote that over the real
 * key, permanently orphaning the event. This is reported instead, so the caller
 * can tell the truth and ask for a fresh wallet-backed deployment.
 */
export class OrganizerIdentityUnavailableError extends Error {
  constructor(readonly address: string) {
    super(
      `This browser no longer holds the organizer key for event ${address}, so the app cannot prove it owns that ` +
        `event. The 1AM wallet's signature is not reproducible, so the missing key cannot be recovered — it is not ` +
        `replaced with a made-up one, because that would silently destroy it. Click "Deploy a new wallet-backed ` +
        `event" to register a fresh event for this wallet.`,
    );
    this.name = 'OrganizerIdentityUnavailableError';
  }
}

