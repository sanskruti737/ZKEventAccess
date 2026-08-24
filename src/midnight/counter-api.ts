import * as Counter from '../../managed/counter/contract/index.js';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  deployContract,
  findDeployedContract,
  type FoundContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import { combineLatest, from, map, type Observable } from 'rxjs';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { witnesses, type CounterPrivateState } from '../witnesses.js';
import type { Logger } from './logger';

export const COUNTER_PRIVATE_STATE_ID = 'counterPrivateState';

export type CounterCircuitKeys = Exclude<keyof Counter.Contract['impureCircuits'], number | symbol>;

export type CounterContract = Counter.Contract<CounterPrivateState, Counter.Witnesses<CounterPrivateState>>;

export type CounterProviders = MidnightProviders<
  CounterCircuitKeys,
  typeof COUNTER_PRIVATE_STATE_ID,
  CounterPrivateState
>;

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
 * Generates a fresh organizer secret key for private state.
 *
 * If the real event organizer has stored their key under
 * `localStorage['zkea.organizerKey']` (64-char hex — see README), it is used so
 * that increment/decrement proofs succeed. The key NEVER reaches the UI or network.
 */
const resolveOrganizerSecretKey = (): Uint8Array => {
  const stored = globalThis.localStorage?.getItem('zkea.organizerKey');
  if (stored && /^[0-9a-fA-F]{64}$/.test(stored)) {
    return new Uint8Array(Buffer.from(stored, 'hex'));
  }
  return crypto.getRandomValues(new Uint8Array(32));
};

/** A joined instance of the ZKEventAccess counter contract. */
export class CounterAPI {
  private constructor(
    public readonly deployed: FoundContract<CounterContract>,
    providers: CounterProviders,
    private readonly logger?: Logger,
  ) {
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

  /**
   * Issues one access credential (organizer-only circuit).
   * The proof is generated locally; only the proof + effect go on-chain.
   */
  async increment(): Promise<void> {
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

  /** Joins the preprod contract deployed in Level 1. */
  static async join(providers: CounterProviders, contractAddress: ContractAddress, logger?: Logger): Promise<CounterAPI> {
    logger?.info({ joinContract: { contractAddress } }, 'joining deployed counter');

    const initialPrivateState: CounterPrivateState = {
      organizerSecretKey: resolveOrganizerSecretKey(),
    };

    const deployed = await findDeployedContract<CounterContract>(providers, {
      contractAddress,
      compiledContract: CompiledCounterContract,
      privateStateId: COUNTER_PRIVATE_STATE_ID,
      initialPrivateState,
    });

    return new CounterAPI(deployed, providers, logger);
  }

  /** Deploys a NEW event instance bound to this browser's organizer key. */
  static async deployNew(providers: CounterProviders, logger?: Logger): Promise<CounterAPI> {
    logger?.info('deploying new counter instance');
    const deployed = await deployContract(providers, {
      compiledContract: CompiledCounterContract,
      privateStateId: COUNTER_PRIVATE_STATE_ID,
      initialPrivateState: { organizerSecretKey: resolveOrganizerSecretKey() },
    });
    return new CounterAPI(deployed, providers, logger);
  }
}
