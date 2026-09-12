import React from 'react';

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
  footer: { color: '#8b949e', fontSize: 12.5, marginTop: 8 },
};

export interface LayoutProps {
  readonly network: string;
  readonly children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ network, children }) => (
  <main style={styles.page}>
    <header style={styles.header}>
      <h1 style={styles.h1}>ZK Event Access</h1>
      <p style={styles.sub}>
        Privacy-preserving event credential ledger on Midnight. Counts are public; the organizer's key is not.
      </p>
      <span style={styles.badge}>network: {network}</span>
    </header>

    {children}

    <footer style={styles.footer}>
      <p>
        Proofs are generated locally in your browser. Only proofs and public effects are submitted to the Midnight
        network.
      </p>
    </footer>
  </main>
);