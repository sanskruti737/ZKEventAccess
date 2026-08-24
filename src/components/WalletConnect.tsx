import React from 'react';
import type { MidnightWalletState } from '../hooks/useMidnight';

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: '1px solid #30363d',
    borderRadius: 12,
    padding: '20px 24px',
    background: '#161b22',
    marginBottom: 20,
  },
  title: { margin: '0 0 12px', fontSize: 15, letterSpacing: 0.3, color: '#9fb3c8' },
  button: {
    padding: '10px 18px',
    borderRadius: 8,
    border: 'none',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
    color: '#fff',
    background: '#1f6feb',
  },
  buttonSecondary: { background: '#21262d', color: '#e6edf3' },
  addressBox: {
    fontFamily: 'monospace',
    fontSize: 13,
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 8,
    padding: '10px 12px',
    wordBreak: 'break-all' as const,
    margin: '10px 0',
  },
  error: { color: '#f85149', fontSize: 13, marginTop: 10 },
  connected: { color: '#3fb950', fontWeight: 600, fontSize: 14 },
};

export interface WalletConnectProps extends MidnightWalletState {
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
}

/**
 * Wallet connect / disconnect UI.
 *
 * - Shows a clear disconnected state (with install guidance on failure)
 * - Connect triggers the Lace Midnight extension
 * - The connected shielded address is displayed on screen
 */
export const WalletConnect: React.FC<WalletConnectProps> = ({ status, address, walletName, error, onConnect, onDisconnect }) => (
  <section style={styles.card}>
    <h2 style={styles.title}>LACE WALLET</h2>

    {status === 'disconnected' && !error && (
      <>
        <p style={{ margin: '0 0 12px', color: '#8b949e', fontSize: 14 }}>
          Not connected. Connect your Lace Midnight wallet to interact with the event contract.
        </p>
        <button style={styles.button} onClick={onConnect}>
          Connect Wallet
        </button>
      </>
    )}

    {status === 'connecting' && (
      <p style={{ color: '#d29922', fontSize: 14 }}>⏳ Waiting for your Midnight wallet… approve the request in 1Money / Lace.</p>
    )}

    {status === 'connected' && (
      <>
        <span style={styles.connected}>● Connected via {walletName ?? 'Midnight wallet'}</span>
        <div style={styles.addressBox}>{address}</div>
        <button style={{ ...styles.button, ...styles.buttonSecondary }} onClick={onDisconnect}>
          Disconnect
        </button>
      </>
    )}

    {error && <div style={styles.error}>⚠ {error}</div>}
  </section>
);
