import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { UnboundTransaction } from '@midnight-ntwrk/midnight-js-types';
import {
  Transaction,
  type FinalizedTransaction,
  type Proof,
  type Binding,
  type SignatureEnabled,
  type TransactionId,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { ConnectedAPI, type InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import semver from 'semver';
import type { CounterCircuitKeys, CounterProviders } from './counter-api';
import { COUNTER_PRIVATE_STATE_ID } from './counter-api';
import type { CounterPrivateState } from '../witnesses.js';
import { inMemoryPrivateStateProvider } from './in-memory-private-state-provider';
import type { Logger } from './logger';

export const NETWORK_ID = (import.meta.env.VITE_NETWORK_ID as string) ?? 'preprod';
const COMPATIBLE_CONNECTOR_API_VERSION = '4.x';
const DISCOVERY_TIMEOUT_MS = 1_500;
const CONNECT_TIMEOUT_MS = 60_000;

export class WalletNotFoundError extends Error {
  constructor() {
    super('Midnight Lace wallet extension not found. Install it from https://www.lace.io/');
    this.name = 'WalletNotFoundError';
  }
}

export class UserRejectedError extends Error {
  constructor() {
    super('Connection request was rejected in the wallet.');
    this.name = 'UserRejectedError';
  }
}

export class NetworkMismatchError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(`Wallet is on network "${actual ?? 'unknown'}" but this app requires "${expected}". Switch networks.`);
    this.name = 'NetworkMismatchError';
  }
}

const getFirstCompatibleWallet = (): InitialAPI | undefined => {
  if (!window.midnight) return undefined;
  return Object.values(window.midnight).find(
    (wallet): wallet is InitialAPI =>
      !!wallet && typeof wallet === 'object' && 'apiVersion' in wallet && typeof wallet.apiVersion === 'string',
  );
};

/** Polls for the injected `window.midnight` connector until Lace responds. */
export const waitForConnector = (): Promise<InitialAPI> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const api = getFirstCompatibleWallet();
      if (api && semver.satisfies(api.apiVersion, COMPATIBLE_CONNECTOR_API_VERSION)) {
        resolve(api);
        return;
      }
      if (Date.now() - started > DISCOVERY_TIMEOUT_MS) {
        reject(new WalletNotFoundError());
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });

export interface ProvidersBundle {
  readonly providers: CounterProviders;
  readonly connectedAPI: ConnectedAPI;
  /** Bech32m shielded address shown in the UI. */
  readonly address: string;
}

let cached: Promise<ProvidersBundle> | undefined;

/**
 * Connects to Lace (or reuses the existing connection) and initializes all
 * Midnight providers needed to interact with the deployed contract.
 */
export const connectAndGetProviders = (logger: Logger): Promise<ProvidersBundle> => {
  if (cached) return cached;
  cached = initializeProviders(logger).catch((err) => {
    cached = undefined;
    throw err;
  });
  return cached;
};

/** Clears cached connection state (local side only; wallet authorization persists). */
export const resetConnection = (): void => {
  cached = undefined;
};

const initializeProviders = async (logger: Logger): Promise<ProvidersBundle> => {
  logger.info('initializing providers: waiting for wallet connector');
  const initialAPI = await waitForConnector();

  let connectedAPI: ConnectedAPI;
  try {
    connectedAPI = await initialAPI.connect(NETWORK_ID);
  } catch (err) {
    logger.error({ err }, 'wallet connect failed');
    throw new UserRejectedError();
  }

  const status = await connectedAPI.getConnectionStatus();
  if (status.status !== 'connected') {
    throw new UserRejectedError();
  }
  const connectedNetwork = (status as { networkId?: string }).networkId;
  if (connectedNetwork !== undefined && connectedNetwork !== NETWORK_ID) {
    throw new NetworkMismatchError(NETWORK_ID, connectedNetwork);
  }

  // The Lace configuration tells us which indexer/prover endpoints to use.
  const config = await connectedAPI.getConfiguration();
  logger.info({ prover: config.proverServerUri, indexer: config.indexerUri }, 'wallet configuration resolved');

  const zkConfigProvider = new FetchZkConfigProvider<CounterCircuitKeys>(window.location.origin, fetch.bind(window));
  const privateStateProvider = inMemoryPrivateStateProvider<typeof COUNTER_PRIVATE_STATE_ID, CounterPrivateState>();
  const keyMaterialProvider = zkConfigProvider;
  const proofProvider = httpClientProofProvider(config.proverServerUri!, keyMaterialProvider);
  const publicDataProvider = indexerPublicDataProvider(config.indexerUri, config.indexerWsUri);

  const shieldedAddresses = await connectedAPI.getShieldedAddresses();
  const address = shieldedAddresses.shieldedAddress;

  const providers: CounterProviders = {
    privateStateProvider,
    zkConfigProvider,
    proofProvider,
    publicDataProvider,
    walletProvider: {
      getCoinPublicKey(): string {
        return shieldedAddresses.shieldedCoinPublicKey;
      },
      getEncryptionPublicKey(): string {
        return shieldedAddresses.shieldedEncryptionPublicKey;
      },
      balanceTx: async (tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> => {
        void ttl;
        logger.info('balancing transaction via wallet');
        const serializedTx = toHex(tx.serialize());
        const received = await connectedAPI.balanceUnsealedTransaction(serializedTx);
        return Transaction.deserialize<SignatureEnabled, Proof, Binding>(
          'signature',
          'proof',
          'binding',
          fromHex(received.tx),
        );
      },
    },
    midnightProvider: {
      submitTx: async (tx: FinalizedTransaction): Promise<TransactionId> => {
        await connectedAPI.submitTransaction(toHex(tx.serialize()));
        const txIdentifiers = tx.identifiers();
        logger.info({ txIdentifiers }, 'transaction submitted via wallet');
        return txIdentifiers[0];
      },
    },
  };

  return { providers, connectedAPI, address };
};
