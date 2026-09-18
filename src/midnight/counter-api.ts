import * as Counter from '../../managed/counter/contract/index.js';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  deployContract,
  findDeployedContract,
  type FoundContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import { combineLatest, from, map, type Observable } from 'rxjs';
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
}

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
 * Resolves the organizer secret key from the wallet-bound private state provider
 * if this session provisioned one, otherwise derives it deterministically from
 * the connected 1AM wallet. The key is stored only in the private state provider
 * (never localStorage, never the UI, never logged) and is used as the proof
 * witness. There is no random-key fallback.
 */
const resolveOrDeriveOrganizerSecretKey = async (providers: CounterProviders): Promise<Uint8Array> => {
  const existing = await resolveOrganizerSecretKey(providers);
  if (existing) return existing;
  if (!providers.organizerIdentity) {
    throw new Error(
      'Organizer authorization failed: the connected 1AM wallet does not expose a wallet-owned organizer identity, ' +
        'so it cannot issue credentials. Only the wallet that owns the event organizer identity can increment.',
    );
  }
  const derived = await providers.organizerIdentity.deriveOrganizerSecretKey();
  if (derived.length !== 32) {
    throw new Error('Organizer authorization failed: the 1AM wallet produced an invalid organizer key length.');
  }
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
    await resolveOrDeriveOrganizerSecretKey(this.providers);
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
   */
  static async deployNew(providers: CounterProviders, logger?: Logger): Promise<CounterAPI> {
    logger?.info('deploying new counter instance');
    const organizerSecretKey = await resolveOrDeriveOrganizerSecretKey(providers);
    const deployed = await deployContract(providers, {
      compiledContract: CompiledCounterContract,
      privateStateId: COUNTER_PRIVATE_STATE_ID,
      initialPrivateState: { organizerSecretKey },
    });
    return new CounterAPI(deployed, providers, logger);
  }
}
