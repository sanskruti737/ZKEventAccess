import { useCallback, useRef, useState } from 'react';
import {
  connectAndGetProviders,
  resetConnection,
  NetworkMismatchError,
  UserRejectedError,
  WalletNotFoundError,
  type ProvidersBundle,
} from '../midnight/providers';
import { consoleLogger, type Logger } from '../midnight/logger';

const logger: Logger = consoleLogger('info');

export type WalletStatus = 'disconnected' | 'connecting' | 'connected';

export interface MidnightWalletState {
  readonly status: WalletStatus;
  /** Bech32m shielded address of the connected Lace wallet. */
  readonly address?: string;
  /** Wallet display name (e.g. "Lace", "1AM"). */
  readonly walletName?: string;
  readonly error?: string;
}

/**
 * React hook managing the Lace wallet connection lifecycle:
 * connect, disconnect, and friendly error mapping.
 */
export const useMidnight = () => {
  const [state, setState] = useState<MidnightWalletState>({ status: 'disconnected' });
  const bundle = useRef<ProvidersBundle | undefined>(undefined);
  const autoTried = useRef(false);

  const connect = useCallback(async () => {
    if (bundle.current) return;
    setState({ status: 'connecting' });
    try {
      const b = await connectAndGetProviders(logger);
      bundle.current = b;
      setState({ status: 'connected', address: b.address, walletName: b.walletName });
    } catch (err) {
      if (err instanceof WalletNotFoundError) {
        setState({ status: 'disconnected', error: err.message });
      } else if (err instanceof UserRejectedError) {
        setState({ status: 'disconnected', error: err.message });
      } else if (err instanceof NetworkMismatchError) {
        setState({ status: 'disconnected', error: err.message });
      } else {
        logger.error({ err }, 'connect failed');
        setState({
          status: 'disconnected',
          error: err instanceof Error ? err.message : 'Failed to connect wallet.',
        });
      }
    }
  }, []);

  /** Silently re-establish an already-authorized connection after a page reload. */
  const autoConnect = useCallback(() => {
    if (autoTried.current || bundle.current) return;
    autoTried.current = true;
    (async () => {
      try {
        const b = await connectAndGetProviders(logger);
        bundle.current = b;
        setState({ status: 'connected', address: b.address, walletName: b.walletName });
      } catch {
        // Stay quietly disconnected — the user can click Connect Wallet manually.
      }
    })();
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
