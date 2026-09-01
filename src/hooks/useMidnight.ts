import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connectAndGetProviders,
  resetConnection,
  findFreshLaceWallet,
  startWalletDetection,
  NETWORK_ID,
  NetworkMismatchError,
  UserRejectedError,
  WalletNotFoundError,
  type ProvidersBundle,
} from '../midnight/providers';
import type { InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { consoleLogger, type Logger } from '../midnight/logger';

const logger: Logger = consoleLogger('info');

export type WalletStatus = 'disconnected' | 'connecting' | 'connected';

export interface MidnightWalletState {
  readonly status: WalletStatus;
  readonly address?: string;
  readonly walletName?: string;
  readonly error?: string;
}

const isShutdownError = (msg: string): boolean => /shutdown|closed|used|channel/i.test(msg);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

export const useMidnight = () => {
  const [state, setState] = useState<MidnightWalletState>({ status: 'disconnected' });
  const bundle = useRef<ProvidersBundle | undefined>(undefined);
  const autoTried = useRef(false);
  const connecting = useRef(false);
  const stopDetection = useRef<(() => void) | undefined>(undefined);

  useEffect(() => () => {
    stopDetection.current?.();
    resetConnection();
  }, []);

  const doConnect = useCallback(async (attempt = 0): Promise<void> => {
    const wallet: InitialAPI | undefined = attempt === 0
      ? findFreshLaceWallet()
      : await sleep(RETRY_DELAY_MS).then(() => findFreshLaceWallet());

    if (!wallet) {
      if (attempt < MAX_RETRIES) {
        return doConnect(attempt + 1);
      }
      throw new WalletNotFoundError();
    }

    console.log(`[app] connect attempt ${attempt + 1}, wallet: ${wallet.name}`);
    const connectPromise = wallet.connect(NETWORK_ID);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Connection timed out. Lace popup may have been blocked.')), 30_000),
    );
    resetConnection();
    return connectAndGetProviders(logger, Promise.race([connectPromise, timeoutPromise])).then(
      (b) => {
        bundle.current = b;
        setState({ status: 'connected', address: b.address, walletName: b.walletName });
      },
      async (err) => {
        const msg = err instanceof Error ? err.message : 'Failed to connect wallet.';

        if (isShutdownError(msg) && attempt < MAX_RETRIES) {
          console.warn(`[app] channel shutdown on attempt ${attempt + 1} — retrying with fresh wallet reference...`);
          resetConnection();
          return doConnect(attempt + 1);
        }

        connecting.current = false;
        if (err instanceof WalletNotFoundError || err instanceof UserRejectedError || err instanceof NetworkMismatchError) {
          setState({ status: 'disconnected', error: msg });
        } else if (isShutdownError(msg)) {
          setState({
            status: 'disconnected',
            error: 'Wallet channel keeps shutting down. Disable the 1AM wallet extension, refresh, and try again.',
          });
        } else {
          setState({ status: 'disconnected', error: msg });
        }
      },
    );
  }, []);

  const connect = useCallback(() => {
    if (bundle.current || connecting.current) return;
    connecting.current = true;
    setState({ status: 'connecting' });
    doConnect().catch(() => { connecting.current = false; });
  }, [doConnect]);

  const autoConnect = useCallback(() => {
    if (autoTried.current) return;
    autoTried.current = true;
    stopDetection.current = startWalletDetection();
  }, []);

  const disconnect = useCallback(() => {
    connecting.current = false;
    resetConnection();
    bundle.current = undefined;
    setState({ status: 'disconnected' });
  }, []);

  const getBundle = useCallback(() => bundle.current, []);

  return { ...state, connect, disconnect, getBundle, autoConnect };
};
