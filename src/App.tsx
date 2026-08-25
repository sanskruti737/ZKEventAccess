import React from 'react';
import { useMidnight } from './hooks/useMidnight';
import { WalletConnect } from './components/WalletConnect';
import { CircuitCall } from './components/CircuitCall';

const styles: Record<string, React.CSSProperties> = {
  page: { maxWidth: 720, margin: '0 auto', padding: '40px 20px' },
  header: { marginBottom: 8 },
  h1: { fontSize: 26, margin: 0 },
  sub: { color: '#8b949e', fontSize: 14, marginTop: 6, marginBottom: 28 },
  badge: {
    display: 'inline-block',
    fontSize: 12,
    border: '1px solid #30363d',
    borderRadius: 999,
    padding: '3px 10px',
    color: '#58a6ff',
    marginBottom: 16,
  },
};

const App: React.FC = () => {
  const wallet = useMidnight();

  React.useEffect(() => {
    wallet.autoConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.h1}>ZK Event Access</h1>
        <p style={styles.sub}>
          Privacy-preserving event credential ledger on Midnight. Counts are public; the organizer's key is not.
        </p>
        <span style={styles.badge}>network: preprod</span>
      </header>

      <WalletConnect
        status={wallet.status}
        address={wallet.address}
        walletName={wallet.walletName}
        error={wallet.error}
        onConnect={() => void wallet.connect()}
        onDisconnect={wallet.disconnect}
      />

      <CircuitCall connected={wallet.status === 'connected'} getBundle={wallet.getBundle} />

      <footer>
        <p style={{ color: '#8b949e', fontSize: 12.5 }}>
          Proofs are generated locally in your browser. Only proofs and public effects are submitted to the Midnight
          network.
        </p>
      </footer>
    </main>
  );
};

export default App;
