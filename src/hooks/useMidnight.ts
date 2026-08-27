import { useCallback, useRef, useState } from 'react';
import {
  connectAndGetProviders,
  resetConnection,
  getDetectedWallet,
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

export const useMidnight = () => {
  const [state, setState] = useState<MidnightWalletState>({ status: 'disconnected' });
  const bundle = useRef<ProvidersBundle | undefined>(undefined);
  const autoTried = useRef(false);

  const connect = useCallback(() => {
    if (bundle.current) return;
    resetConnection();
    const wallet = getDetectedWallet();
    if (!wallet) {
      setState({ status: 'disconnected', error: 'No wallet detected yet. Make sure Lace is installed, unlocked, and refresh the page.' });
      return;
    }
    setState({ status: 'connecting' });
    console.log('[app] connect clicked, wallet:', wallet.name);
    try {
      const connectPromise = wallet.connect(NETWORK_ID);
      console.log('[app] wallet.connect() called, promise created');
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Connection timed out. Check if the Lace wallet popup was blocked or dismissed.')), 60_000),
      );
      const racePromise = Promise.race([connectPromise, timeoutPromise]);
      connectAndGetProviders(logger, racePromise).then(
        (b) => {
          console.log('[app] connected successfully!', b.walletName, b.address?.slice(0, 20));
          bundle.current = b;
          setState({ status: 'connected', address: b.address, walletName: b.walletName });
        },
        (err) => {
          console.error('[app] connect failed:', err);
          const msg = err instanceof Error ? err.message : 'Failed to connect wallet.';
          if (err instanceof WalletNotFoundError) {
            setState({ status: 'disconnected', error: msg });
          } else if (err instanceof UserRejectedError) {
            setState({ status: 'disconnected', error: msg });
          } else if (err instanceof NetworkMismatchError) {
            setState({ status: 'disconnected', error: msg });
          } else if (/shutdown|closed|used/i.test(msg)) {
            setState({
              status: 'disconnected',
              error: 'Wallet channel was closed. Open Lace → Settings → Disconnect All Sites, then refresh and try again.',
            });
          } else {
            setState({ status: 'disconnected', error: msg });
          }
        },
      );
    } catch (err) {
      console.error('[app] connect threw synchronously:', err);
      setState({
        status: 'disconnected',
        error: err instanceof Error ? err.message : 'Failed to connect wallet.',
      });
    }
  }, []);

  /** Silently detect wallet on page load — do NOT call connect() here
   *  because Lace requires a user gesture (click) to show its popup. */
  const autoConnect = useCallback(() => {
    if (autoTried.current) return;
    autoTried.current = true;
    startWalletDetection();
  }, []);

  const disconnect = useCallback(() => {
    resetConnection();
    bundle.current = undefined;
    setState({ status: 'disconnected' });
  }, []);

  /** Internal accessor for components that need the provider bundle. */
  const getBundle = useCallback(() => bundle.current, []);

  return { ...state, connect, disconnect, getBundle, autoConnect };
};
