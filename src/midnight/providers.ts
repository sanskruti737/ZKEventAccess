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
import type { CounterCircuitKeys, CounterProviders } from './counter-api';
import { COUNTER_PRIVATE_STATE_ID } from './counter-api';
import type { CounterPrivateState } from '../witnesses.js';
import { inMemoryPrivateStateProvider } from './in-memory-private-state-provider';
import type { Logger } from './logger';

export const NETWORK_ID = (import.meta.env.VITE_NETWORK_ID as string) ?? 'preprod';

const FALLBACK_PROVER_URI =
  (import.meta.env.VITE_PROOF_SERVER_URL as string | undefined) ?? 'http://127.0.0.1:6300';

const FALLBACK_INDEXER_HTTP = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const FALLBACK_INDEXER_WS = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';

export class WalletNotFoundError extends Error {
  constructor() {
    super('No Midnight wallet found. Install Lace (lace.io), then reload.');
    this.name = 'WalletNotFoundError';
  }
}

export class UserRejectedError extends Error {
  constructor(cause?: string) {
    super(cause ? `Connection rejected by wallet: ${cause}` : 'Connection request was rejected in the wallet.');
    this.name = 'UserRejectedError';
  }
}

export class NetworkMismatchError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(`Wallet is on network "${actual ?? 'unknown'}" but this app requires "${expected}". Switch networks.`);
    this.name = 'NetworkMismatchError';
  }
}

const isCompatibleWallet = (wallet: unknown): wallet is InitialAPI =>
  !!wallet &&
  typeof wallet === 'object' &&
  'apiVersion' in wallet &&
  typeof (wallet as unknown as { apiVersion?: unknown }).apiVersion === 'string' &&
  typeof (wallet as unknown as { connect?: unknown }).connect === 'function';

const isLace = (wallet: InitialAPI): boolean => {
  const name = (wallet as unknown as { name?: string }).name?.toLowerCase() ?? '';
  return name.includes('lace');
};

/**
 * Synchronously reads window.midnight right now and returns the Lace wallet.
 * Returns undefined if not found. Does NOT cache — always fresh.
 */
export const findFreshLaceWallet = (): InitialAPI | undefined => {
  if (!window.midnight) return undefined;
  const allCompatible = Object.values(window.midnight).filter(isCompatibleWallet);
  const lace = allCompatible.find(isLace);
  if (lace) return lace;
  if (allCompatible.length > 0) return allCompatible[0];
  return undefined;
};

const getFirstCompatibleWallet = (): InitialAPI | undefined => {
  if (!window.midnight) return undefined;
  const allCompatible = Object.values(window.midnight).filter(isCompatibleWallet);
  const lace = allCompatible.find(isLace);
  if (lace) return lace;
  if (allCompatible.length > 0) return allCompatible[0];
  return undefined;
};

let detectedWallet: InitialAPI | undefined;

export const getDetectedWallet = (): InitialAPI | undefined => detectedWallet;

export const clearDetectedWallet = (): void => {
  detectedWallet = undefined;
};

export const startWalletDetection = (): (() => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = () => {
    if (stopped) return;
    const api = getFirstCompatibleWallet();
    if (api) {
      detectedWallet = api;
      return;
    }
    timer = setTimeout(poll, 200);
  };
  poll();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
};

export interface ProvidersBundle {
  readonly providers: CounterProviders;
  readonly connectedAPI: ConnectedAPI;
  readonly address: string;
  readonly walletName: string;
}

let cached: Promise<ProvidersBundle> | undefined;

export const connectAndGetProviders = (logger: Logger, connectedPromise: Promise<ConnectedAPI>): Promise<ProvidersBundle> => {
  if (cached) return cached;
  cached = initializeProviders(logger, connectedPromise).catch((err) => {
    cached = undefined;
    throw err;
  });
  return cached;
};

export const resetConnection = (): void => {
  cached = undefined;
};

const initializeProviders = async (logger: Logger, connectedPromise: Promise<ConnectedAPI>): Promise<ProvidersBundle> => {
  const initialAPI = detectedWallet;
  if (!initialAPI) {
    throw new WalletNotFoundError();
  }

  logger.info({ wallet: initialAPI.name }, 'using detected wallet');

  let connectedAPI: ConnectedAPI;
  try {
    connectedAPI = await connectedPromise;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UserRejectedError(detail);
  }

  try {
    const status = await connectedAPI.getConnectionStatus();
    console.log('[wallet] connection status:', JSON.stringify(status));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/shutdown|closed|used/i.test(detail)) {
      throw new Error('Lace wallet channel closed. Disable other wallet extensions, refresh, and try again.');
    }
    console.warn('[wallet] getConnectionStatus warning:', detail);
  }

  let config: Partial<{ proverServerUri?: string; indexerUri?: string; indexerWsUri?: string }> = {};
  try {
    config = (await connectedAPI.getConfiguration()) ?? {};
  } catch {
    console.warn('[wallet] getConfiguration failed — using fallback endpoints');
  }
  const proverUri = config.proverServerUri || FALLBACK_PROVER_URI;
  const indexerUri = config.indexerUri || FALLBACK_INDEXER_HTTP;
  const indexerWsUri = config.indexerWsUri || FALLBACK_INDEXER_WS;

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
  } catch {
    throw new Error('Connected, but the wallet did not return your address. Try reconnecting.');
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
        return txIdentifiers[0];
      },
    },
  };

  return { providers, connectedAPI, address, walletName: initialAPI.name ?? 'Midnight wallet' };
};
