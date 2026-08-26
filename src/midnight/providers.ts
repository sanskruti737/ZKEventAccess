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
    super('No Midnight wallet found. Install Lace (lace.io), disable other wallet extensions (like 1AM), then reload.');
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

const getFirstCompatibleWallet = (): InitialAPI | undefined => {
  console.log('[wallet] checking window.midnight:', window.midnight);
  if (!window.midnight) {
    console.warn('[wallet] window.midnight is undefined — wallet extension not detected');
    return undefined;
  }
  const keys = Object.keys(window.midnight);
  console.log('[wallet] window.midnight keys:', keys);
  const allCompatible = Object.values(window.midnight).filter(isCompatibleWallet);
  console.log('[wallet] compatible wallets:', allCompatible.map((w) => ({
    name: (w as any)?.name,
    apiVersion: w.apiVersion,
  })));

  const lace = allCompatible.find(isLace);
  if (lace) {
    console.log('[wallet] selected Lace wallet:', lace.name, 'API', lace.apiVersion);
    return lace;
  }

  if (allCompatible.length > 0) {
    console.warn('[wallet] Lace not found, falling back to first compatible wallet:', allCompatible[0].name);
    return allCompatible[0];
  }

  console.warn('[wallet] found window.midnight but no compatible connector (needs apiVersion + connect)');
  return undefined;
};

let detectedWallet: InitialAPI | undefined;

export const getDetectedWallet = (): InitialAPI | undefined => detectedWallet;

export const startWalletDetection = (): void => {
  const poll = () => {
    const api = getFirstCompatibleWallet();
    if (api) {
      detectedWallet = api;
      return;
    }
    setTimeout(poll, 200);
  };
  poll();
};

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
 * Kicks off wallet connect() synchronously (must be called from a user
 * gesture to avoid Lace popup blocking) and then sets up providers.
 */
export const connectAndGetProviders = (logger: Logger, connectedPromise: Promise<ConnectedAPI>): Promise<ProvidersBundle> => {
  if (cached) return cached;
  cached = initializeProviders(logger, connectedPromise).catch((err) => {
    cached = undefined;
    throw err;
  });
  return cached;
};

/** Clears cached connection state (local side only; wallet authorization persists). */
export const resetConnection = (): void => {
  cached = undefined;
};

const initializeProviders = async (logger: Logger, connectedPromise: Promise<ConnectedAPI>): Promise<ProvidersBundle> => {
  const initialAPI = detectedWallet;
  if (!initialAPI) {
    throw new WalletNotFoundError();
  }
  logger.info({ wallet: initialAPI.name }, 'using detected wallet');
  console.log('[wallet] starting initializeProviders for:', initialAPI.name);

  let connectedAPI: ConnectedAPI;
  try {
    console.log('[wallet] awaiting connect promise...');
    connectedAPI = await connectedPromise;
    console.log('[wallet] connect resolved, testing channel...');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[wallet] connect threw:', detail);
    throw new UserRejectedError(detail);
  }

  try {
    const status = await connectedAPI.getConnectionStatus();
    console.log('[wallet] connection status:', JSON.stringify(status));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/shutdown|closed|used/i.test(detail)) {
      throw new Error('Lace wallet channel closed. Disable other wallet extensions (1AM), make sure Lace is on Preprod network, then refresh and try again.');
    }
    console.warn('[wallet] getConnectionStatus warning:', detail);
  }

  let config: Partial<{ proverServerUri?: string; indexerUri?: string; indexerWsUri?: string }> = {};
  try {
    config = (await connectedAPI.getConfiguration()) ?? {};
    console.log('[wallet] configuration:', JSON.stringify(config));
  } catch (err) {
    console.warn('[wallet] getConfiguration failed — using fallback endpoints:', err);
  }
  const proverUri = config.proverServerUri || FALLBACK_PROVER_URI;
  const indexerUri = config.indexerUri || FALLBACK_INDEXER_HTTP;
  const indexerWsUri = config.indexerWsUri || FALLBACK_INDEXER_WS;
  console.log('[wallet] prover:', proverUri, 'indexer:', indexerUri);

  const zkConfigProvider = new FetchZkConfigProvider<CounterCircuitKeys>(window.location.origin, fetch.bind(window));
  const privateStateProvider = inMemoryPrivateStateProvider<typeof COUNTER_PRIVATE_STATE_ID, CounterPrivateState>();
  const keyMaterialProvider = zkConfigProvider;
  const proofProvider = httpClientProofProvider(proverUri, keyMaterialProvider);
  const publicDataProvider = indexerPublicDataProvider(indexerUri, indexerWsUri);

  let address = 'unknown';
  let coinPublicKey = '';
  let encryptionPublicKey = '';
  try {
    console.log('[wallet] calling getShieldedAddresses...');
    const shieldedAddresses = await connectedAPI.getShieldedAddresses();
    console.log('[wallet] shielded addresses received');
    address = shieldedAddresses.shieldedAddress ?? 'unknown';
    coinPublicKey = shieldedAddresses.shieldedCoinPublicKey ?? '';
    encryptionPublicKey = shieldedAddresses.shieldedEncryptionPublicKey ?? '';
    console.log('[wallet] address:', address.slice(0, 20) + '...');
  } catch (err) {
    console.error('[wallet] getShieldedAddresses failed:', err);
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
