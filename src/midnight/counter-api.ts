import * as Counter from '../../managed/counter/contract/index.js';
import { CompactTypeBytes, CompactTypeVector, persistentHash } from '@midnight-ntwrk/compact-runtime';
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
import { witnesses, type CounterPrivateState } from '../witnesses.js';
import type { Logger } from './logger';

export const COUNTER_PRIVATE_STATE_ID = 'counterPrivateState';

export type CounterCircuitKeys = Exclude<keyof Counter.Contract['impureCircuits'], number | symbol>;

export type CounterContract = Counter.Contract<CounterPrivateState, Counter.Witnesses<CounterPrivateState>>;

/**
 * Wallet-owned organizer identity capability.
 *
 * `deriveOrganizerSecretKey` deterministically derives the organizer secret key
 * bound to the connected 1AM wallet (via its `signData` capability over a fixed
 * domain message). The same wallet reproduces the same key on every session, so
 * the organizer secret never needs to be stored, pasted, or generated at random:
 * it lives inside the wallet's own key material and is only materialized in the
 * browser for the brief moment a proof is produced.
 */
export interface OrganizerIdentity {
  readonly deriveOrganizerSecretKey: () => Promise<Uint8Array>;
}

export type CounterProviders = MidnightProviders<
  CounterCircuitKeys,
  typeof COUNTER_PRIVATE_STATE_ID,
  CounterPrivateState
> & {
  readonly organizerIdentity?: OrganizerIdentity;
};

/** The contract binding with our witnesses attached; key material comes from the zkConfigProvider at runtime. */
export const CompiledCounterContract = CompiledContract.make<Counter.Contract<CounterPrivateState>>(
  'counter',
  Counter.Contract,
).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets('./managed/counter'),
);

export interface CounterLedgerState {
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

export const organizerCommitment = (secretKey: Uint8Array): string =>
  toHex(new Uint8Array(persistentHash(new CompactTypeVector(2, new CompactTypeBytes(32)), [ORGANIZER_DOMAIN, secretKey])));

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
 * Hex digests of organizer keys this session materialized as organizer identity
 * (via wallet derivation or `deployNew`). Tracked in-memory so join/increment
 * reuse exactly the key the connected 1AM wallet owns for the event, and so a
 * reader placeholder can never be mistaken for a real organizer key.
 */
const organizerSessionKeys = new Set<string>();

/**
 * Resolves the organizer secret key (proof witness) from the wallet-bound
 * private state provider, under `COUNTER_PRIVATE_STATE_ID`. It is never read
 * from or written to localStorage, and never reaches the UI, `window`, or the
 * network.
 *
 * Only keys this session genuinely materialized as organizer identity are
 * returned. Otherwise it returns `null` so callers can decide to derive the
 * wallet-owned key rather than fabricating one.
 */
const resolveOrganizerSecretKey = async (providers: CounterProviders): Promise<Uint8Array | null> => {
  try {
    const state = (await providers.privateStateProvider.get(COUNTER_PRIVATE_STATE_ID)) as
      | CounterPrivateState
      | null;
    const key = state?.organizerSecretKey;
    if (key && key.length === 32 && organizerSessionKeys.has(toHex(key))) {
      return key;
    }
  } catch {
    // fall through: no organizer identity in this wallet session
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

const deriveWalletOrganizerKey = (providers: CounterProviders): Promise<Uint8Array> => {
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
 * if this session provisioned one, otherwise derives it deterministically from
 * the connected 1AM wallet. The key is stored only in the private state provider
 * (never localStorage, never the UI, never logged) and is used as the proof
 * witness. There is no random-key fallback.
 *
 * The derivation itself is single-flight (see {@link deriveWalletOrganizerKey}):
 * concurrent callers share one wallet signData request, so a single user action
 * can never fan out into duplicate 1AM popups.
 */
const resolveOrDeriveOrganizerSecretKey = async (providers: CounterProviders): Promise<Uint8Array> => {
  const existing = await resolveOrganizerSecretKey(providers);
  if (existing) return existing;
  const derived = await deriveWalletOrganizerKey(providers);
  organizerSessionKeys.add(toHex(derived));
  await providers.privateStateProvider.set(COUNTER_PRIVATE_STATE_ID, { organizerSecretKey: derived });
  return derived;
};

/** A joined instance of the ZKEventAccess counter contract. */
export class CounterAPI {
  private constructor(
    public readonly deployed: FoundContract<CounterContract>,
    providers: CounterProviders,
    private readonly logger?: Logger,
  ) {
    this.providers = providers;
    this.contractAddress = deployed.deployTxData.public.contractAddress;
    providers.privateStateProvider.setContractAddress(this.contractAddress);

    this.state$ = combineLatest([
      providers.publicDataProvider.contractStateObservable(this.contractAddress, { type: 'latest' }).pipe(
        map((contractState) => {
          const ledger = Counter.ledger(contractState.data);
          return {
            counter: ledger.counter,
            announcement: ledger.announcement,
            organizer: toHex(ledger.organizer),
          } satisfies CounterLedgerState;
        }),
      ),
      from(providers.privateStateProvider.get(COUNTER_PRIVATE_STATE_ID) as Promise<CounterPrivateState | null>),
    ]).pipe(map(([ledger]) => ledger));
  }

  readonly contractAddress: ContractAddress;
  readonly state$: Observable<CounterLedgerState>;
  private readonly providers: CounterProviders;

  /**
   * Issues one access credential (organizer-only circuit).
   *
   * The organizer witness key is resolved from the connected 1AM wallet (session
   * private state, or wallet-derived authorization on first use) and used to
   * build a local proof. The on-chain organizer assert remains the final gate —
   * if the connected wallet is not the registered organizer, the chain rejects
   * the call and the error is surfaced truthfully.
   */
  async increment(): Promise<void> {
    const sk = await resolveOrDeriveOrganizerSecretKey(this.providers);
    console.log('[debug] wallet-derived organizer commitment:', organizerCommitment(sk));
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
   * deployed an event, derived deterministically from the wallet's own
   * key material. Used to verify that a persisted/saved event is actually owned
   * by the currently connected 1AM wallet before reusing it.
   */
  static async currentOrganizerCommitment(providers: CounterProviders): Promise<string> {
    const sk = await resolveOrDeriveOrganizerSecretKey(providers);
    return organizerCommitment(sk);
  }

  /**
   * One-shot read of the current on-chain ledger state for this event. Used to
   * refresh the public credential count immediately after a finalized issuance,
   * independent of the state$ poll cadence.
   */
  async readLatest(): Promise<CounterLedgerState> {
    const contractState = await this.providers.publicDataProvider.queryContractState(this.contractAddress);
    if (!contractState) {
      throw new Error('Could not read the current on-chain state for this event.');
    }
    const ledger = Counter.ledger(contractState.data);
    return {
      counter: ledger.counter,
      announcement: ledger.announcement,
      organizer: toHex(ledger.organizer),
    };
  }

  /**
   * Joins the preprod contract. Non-organizer wallets join with a read-only
   * placeholder private state (never used as organizer authority); organizer
   * wallets reuse the exact key they provisioned at deployment.
   */
  static async join(providers: CounterProviders, contractAddress: ContractAddress, logger?: Logger): Promise<CounterAPI> {
    logger?.info({ joinContract: { contractAddress } }, 'joining deployed counter');

    const organizerSecretKey = await resolveOrganizerSecretKey(providers);
    const initialPrivateState: CounterPrivateState = {
      organizerSecretKey: organizerSecretKey ?? new Uint8Array(32),
    };

    const deployed = await findDeployedContract<CounterContract>(providers, {
      contractAddress,
      compiledContract: CompiledCounterContract,
      privateStateId: COUNTER_PRIVATE_STATE_ID,
      initialPrivateState,
    });

    return new CounterAPI(deployed, providers, logger);
  }

  /**
   * Deploys a NEW event instance whose organizer identity is owned by the
   * connected 1AM wallet. The organizer key is derived deterministically from
   * the wallet (never generated at random, never persisted), and the on-chain
   * `organizer` commitment is bound to it — so every future session of that
   * same wallet can re-derive the key and issue credentials without any secret
   * leaving the wallet's key material.
   *
   * After deployment this reads the NEW contract's on-chain state from the
   * indexer and verifies that its registered organizer commitment equals this
   * wallet's derived identity. Only then does it treat the deployment as
   * successful; otherwise it throws and leaves the active event untouched.
   */
  static async deployNew(
    providers: CounterProviders,
    logger?: Logger,
    onDeployedAddress?: (address: string) => void,
  ): Promise<CounterAPI> {
    logger?.info('deploying new counter instance');
    const organizerSecretKey = await resolveOrDeriveOrganizerSecretKey(providers);
    const expectedOrganizer = organizerCommitment(organizerSecretKey);
    console.log('[debug] wallet-derived organizer commitment to register:', expectedOrganizer);

    const deployed = await withTimeout(
      deployContract(providers, {
        compiledContract: CompiledCounterContract,
        privateStateId: COUNTER_PRIVATE_STATE_ID,
        initialPrivateState: { organizerSecretKey },
      }),
      DEPLOY_TIMEOUT_MS,
      `Deployment timed out: the deployment transaction was submitted to the 1AM wallet but no new event ` +
        `appeared on-chain within ${DEPLOY_TIMEOUT_MS / 60000} minutes. Check that you approved it in the wallet ` +
        `and that the wallet has preprod coins for the deployment fee, then retry.`,
    );
    const deployedAddress = String(deployed.deployTxData.public.contractAddress);
    console.log('[debug] newly deployed contract address:', deployedAddress);
    // The deployment transaction is finalized on-chain at this point, so the
    // real address is a fact — publish it immediately so the caller can persist
    // it even if the verification read below times out on a lagging indexer.
    onDeployedAddress?.(deployedAddress);
    console.log('[debug] waiting to verify on-chain organizer of the new event...');

    const api = new CounterAPI(deployed, providers, logger);
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
