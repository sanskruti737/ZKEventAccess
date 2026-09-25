import React from 'react';
import type { MidnightWalletState } from '../hooks/useMidnight';
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderIcon,
  LockIcon,
  ShieldCheckIcon,
  WalletIcon,
} from './Icon';

const shortenAddress = (address: string): string => {
  if (address.length <= 22) return address;
  return `${address.slice(0, 12)}…${address.slice(-8)}`;
};

const useWalletDetection = (active: boolean): string[] | null => {
  const [detected, setDetected] = React.useState<string[] | null>(null);

  React.useEffect(() => {
    if (!active) return undefined;
    setDetected(null);
    const timer = window.setInterval(() => {
      const midnight = (window as unknown as { midnight?: Record<string, unknown> }).midnight;
      const wallets = midnight
        ? Object.values(midnight).filter(
            (wallet): wallet is { name?: string; apiVersion?: string } =>
              !!wallet && typeof wallet === 'object' && 'apiVersion' in wallet,
          )
        : [];
      setDetected(wallets.map((wallet) => `${wallet.name ?? 'Unknown wallet'} · API ${wallet.apiVersion ?? 'unknown'}`));
      window.clearInterval(timer);
    }, 400);
    return () => window.clearInterval(timer);
  }, [active]);

  return detected;
};

export interface WalletConnectProps extends MidnightWalletState {
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
}

export const WalletConnect: React.FC<WalletConnectProps> = ({
  status,
  address,
  walletName,
  error,
  onConnect,
  onDisconnect,
}) => {
  const detected = useWalletDetection(status === 'disconnected');
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    setCopied(false);
  }, [address]);

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="surface-card" id="identity" aria-labelledby="wallet-title" aria-busy={status === 'connecting'}>
      <div className="card-header">
        <span className="section-index" aria-hidden="true">01</span>
        <div className="card-header-copy">
          <div className="section-kicker">Identity layer</div>
          <h2 className="card-title" id="wallet-title">Connect your wallet</h2>
          <p className="card-description">
            1AM is the source of organizer authority. Connect once to manage access for this event.
          </p>
        </div>
        <span className={`status-chip ${status === 'connected' ? 'status-chip-success' : status === 'connecting' ? 'status-chip-warning' : ''}`}>
          <span className="status-dot" aria-hidden="true" />
          {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting' : 'Not connected'}
        </span>
      </div>

      <div className="wallet-body">
        {status === 'disconnected' && (
          <>
            <div className="wallet-hero">
              <div className="wallet-icon-shell" aria-hidden="true">
                <WalletIcon />
              </div>
              <div>
                <h3>Bring your identity onchain</h3>
                <p>Your wallet signs the authorization, not a secret pasted into this page.</p>
              </div>
            </div>

            {error && (
              <div className="alert alert-error" role="alert">
                <AlertIcon />
                <div className="alert-copy">
                  <strong>Connection needs attention</strong>
                  {error}
                </div>
              </div>
            )}

            {detected === null && (
              <div className="wallet-detection" role="status">
                <LoaderIcon />
                <div className="wallet-detection-copy">
                  <strong>Looking for a Midnight wallet</strong>
                  <span>Checking this browser for a compatible 1AM connection.</span>
                </div>
              </div>
            )}

            {detected !== null && detected.length > 0 && !error && (
              <div className={`wallet-detection ${detected.length > 1 ? 'wallet-detection-warning' : ''}`} role="status">
                <ShieldCheckIcon />
                <div className="wallet-detection-copy">
                  <strong>{detected.length > 1 ? 'Multiple wallets detected' : 'Wallet ready to connect'}</strong>
                  <span>{detected.join(' · ')}</span>
                  {detected.length > 1 && (
                    <span>Keep only the 1AM extension enabled, then refresh this page to avoid connection conflicts.</span>
                  )}
                </div>
              </div>
            )}

            {detected !== null && detected.length === 0 && (
              <div className="wallet-detection wallet-detection-warning" role="status">
                <AlertIcon />
                <div className="wallet-detection-copy">
                  <strong>No Midnight wallet detected</strong>
                  <span>
                    Install and unlock 1AM, then refresh. <a href="https://get1am.com" target="_blank" rel="noreferrer">Get 1AM <ExternalLinkIcon width="12" height="12" /></a>
                  </span>
                </div>
              </div>
            )}

            <div className="button-row">
              <button className="primary-button" type="button" onClick={onConnect}>
                <WalletIcon className="button-icon" />
                Connect 1AM wallet
              </button>
            </div>
            <div className="privacy-note">
              <LockIcon />
              Your organizer secret never enters a form or leaves your wallet.
            </div>
          </>
        )}

        {status === 'connecting' && (
          <div className="wallet-connecting" role="status" aria-live="polite">
            <LoaderIcon />
            <div>
              <strong>Waiting for 1AM</strong>
              <p>Approve the network connection in your wallet. This page will continue automatically.</p>
            </div>
          </div>
        )}

        {status === 'connected' && address && (
          <>
            <div className="connected-identity">
              <div className="wallet-icon-shell" aria-hidden="true">
                <WalletIcon />
              </div>
              <div>
                <span className="wallet-status-label">Wallet connected</span>
                <h3>{walletName ?? 'Midnight wallet'}</h3>
                <p>Your wallet is ready for organizer and access actions.</p>
              </div>
            </div>
            <div className="address-block">
              <span className="address-label">Shielded address</span>
              <div className="address-row">
                <code title={address}>{shortenAddress(address)}</code>
                <button className="icon-button" type="button" onClick={copyAddress} aria-label="Copy wallet address" title="Copy address">
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
              </div>
            </div>
            <div className="connected-meta">
              <span><span className="status-dot" aria-hidden="true" /> Secure browser session</span>
              <button className="secondary-button" type="button" onClick={onDisconnect}>Disconnect wallet</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
};
