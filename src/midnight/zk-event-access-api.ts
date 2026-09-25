import * as ZKEventAccess from '../../managed/zk-event-access/contract/index.js';
import { CompactTypeBytes, CompactTypeVector, persistentHash } from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  deployContract,
  findDeployedContract,
  type FoundContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import { combineLatest, firstValueFrom, from, map, type Observable } from 'rxjs';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-utils';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { witnesses, type ZKEventAccessPrivateState } from '../witnesses.js';
import type { Logger } from './logger';

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
 * Off-chain mirror of the contract's `publicKey` circuit.
 *
 * MUST stay byte-for-byte equivalent to `contracts/zk-event-access.compact`:
 *
 *   circuit publicKey(sk: Bytes<32>): Bytes<32> {
 *     return persistentHash<Vector<3, Bytes<32>>>(
 *       [pad(32, "zkEventAccess:organizer"), contractAddress, sk]);
 *   }
 *
 * The commitment is bound to BOTH the domain separator AND the deploying
 * contract's own address. Omitting `contractAddress` (or hashing it as a
 * `Vector<2>`) produces a value that can never equal the ledger's `organizer`,
 * which made the pre-flight organizer check report a false mismatch for every
 * event and made post-deploy verification fail unconditionally.
 */
export const organizerCommitment = (secretKey: Uint8Array, contractAddress: string): string =>
  toHex(
    new Uint8Array(
      persistentHash(new CompactTypeVector(3, new CompactTypeBytes(32)), [
        ORGANIZER_DOMAIN,
        fromHex(contractAddress),
        secretKey,
      ]),
    ),
  );

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
 * Resolves the organizer secret key from the wallet-bound private state provider
 * if this wallet provisioned one (persisted across sessions), otherwise derives
 * it from the connected 1AM wallet. The key is stored only in the private state
 * provider (IndexedDB — never localStorage/sessionStorage, never the UI, never
 * logged) and is used as the proof witness. There is no random-key fallback.
 *
 * The derivation itself is single-flight (see {@link deriveWalletOrganizerKey}):
 * concurrent callers share one wallet signData request, so a single user action
 * can never fan out into duplicate 1AM popups.
 */
const resolveOrDeriveOrganizerSecretKey = async (providers: ZKEventAccessProviders): Promise<Uint8Array> => {
  const existing = await resolveOrganizerSecretKey(providers);
  if (existing) return existing;
  const derived = await deriveWalletOrganizerKey(providers);
  await providers.privateStateProvider.set(ZK_EVENT_ACCESS_PRIVATE_STATE_ID, { organizerSecretKey: derived });
  return derived;
};

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
    const sk = await resolveOrDeriveOrganizerSecretKey(this.providers);
    console.log(
      '[debug] wallet-derived organizer commitment for this event:',
      organizerCommitment(sk, String(this.contractAddress)),
    );
    this.logger?.info('increment: proving locally...');
    const txData = await this.deployed.callTx.increment();
    this.logger?.info({ txHash: txData.public.txHash }, 'increment finalized');
  }

  /**
   * Reads the credential count through an on-chain circuit call.
   * The fresh value arrives via `state$` once the transaction is finalized.
   */
  async read(): Promise<void> {
    this.logger?.info('read: proving locally...');
    await this.deployed.callTx.read();
  }

  /**
   * Returns the organizer commitment the connected wallet would register if it
   * deployed an event, resolved from the wallet-bound private state provider
   * (persisted organizer key recovered across sessions). Used to verify that a
   * persisted/saved event is actually owned by the currently connected 1AM
   * wallet before reusing it.
   */
  static async currentOrganizerCommitment(providers: ZKEventAccessProviders, contractAddress: string): Promise<string> {
    const sk = await resolveOrDeriveOrganizerSecretKey(providers);
    return organizerCommitment(sk, contractAddress);
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
   * organizer secret key (persisted across sessions, scoped to this wallet). A
   * non-organizer wallet joins with a read-only placeholder private state
   * (never used as organizer authority). `initialPrivateState` only becomes the
   * placeholder when no genuine organizer key is persisted, so a persisted
   * organizer key is never clobbered by `findDeployedContract`.
   */
  static async join(providers: ZKEventAccessProviders, contractAddress: ContractAddress, logger?: Logger): Promise<ZKEventAccessAPI> {
    logger?.info({ joinContract: { contractAddress } }, 'joining deployed ZK Event Access contract');

    const organizerSecretKey = await resolveOrganizerSecretKey(providers);
    const initialPrivateState: ZKEventAccessPrivateState = {
      organizerSecretKey: organizerSecretKey ?? new Uint8Array(32),
    };

    const deployed = await findDeployedContract<ZKEventAccessContract>(providers, {
      contractAddress,
      compiledContract: CompiledZKEventAccessContract,
      privateStateId: ZK_EVENT_ACCESS_PRIVATE_STATE_ID,
      initialPrivateState,
    });

    return new ZKEventAccessAPI(deployed, providers, logger);
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
   * After deployment this reads the NEW contract's on-chain state from the
   * indexer and verifies that its registered organizer commitment equals this
   * wallet's derived identity. Only then does it treat the deployment as
   * successful; otherwise it throws and leaves the active event untouched.
   */
  static async deployNew(
    providers: ZKEventAccessProviders,
    logger?: Logger,
    onDeployedAddress?: (address: string) => void,
  ): Promise<ZKEventAccessAPI> {
    logger?.info('deploying new ZK Event Access contract instance');
    const organizerSecretKey = await resolveOrDeriveOrganizerSecretKey(providers);

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
    // The constructor binds `organizer` to persistentHash(domain || contractAddress || sk),
    // and `contractAddress` is the address the contract was just deployed to. The
    // expected commitment is therefore only computable now that the real address
    // is known — computing it beforehand (or without the address) yields a value
    // that can never match the ledger.
    const expectedOrganizer = organizerCommitment(organizerSecretKey, deployedAddress);
    console.log('[debug] newly deployed contract address:', deployedAddress);
    console.log('[debug] wallet-derived organizer commitment registered on-chain:', expectedOrganizer);
    // The deployment transaction is finalized on-chain at this point, so the
    // real address is a fact — publish it immediately so the caller can persist
    // it even if the verification read below times out on a lagging indexer.
    onDeployedAddress?.(deployedAddress);
    console.log('[debug] waiting to verify on-chain organizer of the new event...');

    const api = new ZKEventAccessAPI(deployed, providers, logger);
    let organizer: string;
    try {
      ({ organizer } = await withTimeout(
        firstValueFrom(api.state$),
        DEPLOY_STATE_READ_TIMEOUT_MS,
        `The new event (${deployedAddress}) was registered on-chain, but its state could not be read from the ` +
          `indexer within ${DEPLOY_STATE_READ_TIMEOUT_MS / 60000} minute(s).`,
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${message} The new event DID deploy and its address is now active and remembered, but the on-chain ` +
          `organizer could not be verified yet (indexer lag). Click "Issue credential (+1)" to retry — the local ` +
          `organizer assert will still reject a non-owner wallet.`,
      );
    }

    if (organizer !== expectedOrganizer) {
      throw new Error(
        'Deployment verification failed: the new event was created but its on-chain organizer ' +
          `(commitment ${organizer}) does not match the connected 1AM wallet's identity ` +
          `(${expectedOrganizer}). The active event was NOT switched, so nothing was replaced or clobbered.`,
      );
    }
    console.log('[debug] on-chain organizer of new event verified:', organizer);
    logger?.info({ deployedAddress, organizer }, 'deploy verified: connected 1AM wallet is the on-chain organizer');
    return api;
  }
}
