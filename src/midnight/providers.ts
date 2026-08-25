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
const DISCOVERY_TIMEOUT_MS = 8_000;

const FALLBACK_PROVER_URI =
  (import.meta.env.VITE_PROOF_SERVER_URL as string | undefined) ?? 'http://127.0.0.1:6300';

const FALLBACK_INDEXER_HTTP = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const FALLBACK_INDEXER_WS = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
const CONNECT_TIMEOUT_MS = 60_000;

export class WalletNotFoundError extends Error {
  constructor() {
    super('No Midnight wallet found. Install Lace (lace.io) or 1Money, then reload this page.');
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
      !!wallet &&
      typeof wallet === 'object' &&
      'apiVersion' in wallet &&
      typeof wallet.apiVersion === 'string' &&
      typeof (wallet as unknown as { connect?: unknown }).connect === 'function',
  );
};

/** Polls for the injected `window.midnight` connector until a compatible wallet responds (Lace, 1Money, …). */
export const waitForConnector = (): Promise<InitialAPI> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    let warned = false;
    const poll = () => {
      const api = getFirstCompatibleWallet();
      if (api) {
        if (!semver.satisfies(api.apiVersion, COMPATIBLE_CONNECTOR_API_VERSION) && !warned) {
          warned = true;
          console.warn(`Wallet connector API version ${api.apiVersion} differs from tested ${COMPATIBLE_CONNECTOR_API_VERSION}; attempting anyway.`);
        }
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
  /** Wallet display name (e.g. "Lace", "1AM"). */
  readonly walletName: string;
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

  // Some wallets resolve connect() before approval completes or return
  // differently-shaped status objects — treat a resolved connect() as success
  // and only use status/network info when it matches the expected shape.
  try {
    const status = await connectedAPI.getConnectionStatus();
    const connectedNetwork = (status as { networkId?: string } | undefined)?.networkId;
    const isConnected =
      typeof status === 'object' && status !== null && 'status' in (status as object)
        ? (status as { status?: unknown }).status === 'connected'
        : true;
    logger.info({ status }, 'connection status');
    if (!isConnected) throw new UserRejectedError();
    if (typeof connectedNetwork === 'string' && connectedNetwork !== NETWORK_ID) {
      logger.warn(
        `wallet reports network "${connectedNetwork}" while app expects "${NETWORK_ID}" — continuing`,
      );
    }
  } catch (err) {
    if (err instanceof UserRejectedError) throw err;
    logger.warn({ err }, 'could not read connection status — continuing anyway');
  }

  // The wallet configuration tells us which indexer/prover endpoints to use.
  // Some wallets (e.g. 1AM) may omit the prover URI — fall back to a local
  // proof server or VITE_PROOF_SERVER_URL in that case.
  let config: Partial<{ proverServerUri?: string; indexerUri?: string; indexerWsUri?: string }> = {};
  try {
    config = (await connectedAPI.getConfiguration()) ?? {};
  } catch (err) {
    logger.warn({ err }, 'getConfiguration failed — using fallback endpoints');
  }
  const proverUri = config.proverServerUri || FALLBACK_PROVER_URI;
  const indexerUri = config.indexerUri || FALLBACK_INDEXER_HTTP;
  const indexerWsUri = config.indexerWsUri || FALLBACK_INDEXER_WS;
  logger.info(
    { wallet: initialAPI.name, prover: proverUri, indexer: indexerUri, indexerWs: indexerWsUri },
    'wallet configuration resolved',
  );

  const zkConfigProvider = new FetchZkConfigProvider<CounterCircuitKeys>(window.location.origin, fetch.bind(window));
  const privateStateProvider = inMemoryPrivateStateProvider<typeof COUNTER_PRIVATE_STATE_ID, CounterPrivateState>();
  const keyMaterialProvider = zkConfigProvider;
  const proofProvider = httpClientProofProvider(proverUri, keyMaterialProvider);
  const publicDataProvider = indexerPublicDataProvider(indexerUri, indexerWsUri);

  let address = 'unknown';
  let coinPublicKey = '';
  let encryptionPublicKey = '';
  try {
    const shieldedAddresses = await connectedAPI.getShieldedAddresses();
    address = shieldedAddresses.shieldedAddress ?? 'unknown';
    coinPublicKey = shieldedAddresses.shieldedCoinPublicKey ?? '';
    encryptionPublicKey = shieldedAddresses.shieldedEncryptionPublicKey ?? '';
  } catch (err) {
    logger.error({ err }, 'getShieldedAddresses failed');
    throw new Error('Connected, but the wallet did not return your address. Try unlocking 1AM fully and reconnecting.');
  }

  const providers: CounterProviders = {
    privateStateProvider,
    zkConfigProvider,
    proofProvider,
    publicDataProvider,
    walletProvider: {
      getCoinPublicKey(): string {
        return coinPublicKey;
      },
      getEncryptionPublicKey(): string {
        return encryptionPublicKey;
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

  return { providers, connectedAPI, address, walletName: initialAPI.name ?? 'Midnight wallet' };
};
