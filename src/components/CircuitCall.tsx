import React, { useEffect, useState } from 'react';
import { CounterAPI, type CounterLedgerState } from '../midnight/counter-api';
import { NETWORK_ID } from '../midnight/providers';
import type { ProvidersBundle } from '../midnight/providers';

const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS as string;

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: '1px solid #30363d',
    borderRadius: 12,
    padding: '20px 24px',
    background: '#161b22',
    marginBottom: 20,
  },
  title: { margin: '0 0 12px', fontSize: 15, letterSpacing: 0.3, color: '#9fb3c8' },
  counter: { fontSize: 42, fontWeight: 700, margin: '4px 0 2px', color: '#58a6ff' },
  label: { color: '#8b949e', fontSize: 13 },
  buttonRow: { display: 'flex', gap: 12, marginTop: 18 },
  button: {
    padding: '10px 18px',
    borderRadius: 8,
    border: 'none',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
    color: '#fff',
    background: '#238636',
  },
  buttonSecondary: { background: '#1f6feb' },
  buttonDisabled: { opacity: 0.55, cursor: 'wait' },
  privacyNote: {
    marginTop: 14,
    fontSize: 12.5,
    color: '#7ee787',
    border: '1px dashed #238636',
    borderRadius: 8,
    padding: '8px 10px',
    display: 'inline-block',
  },
  status: { marginTop: 12, fontSize: 13.5 },
  ok: { color: '#3fb950' },
  err: { color: '#f85149' },
  busy: { color: '#d29922' },
};

type Phase = 'idle' | 'joining' | 'proving' | 'done' | 'error';

export interface CircuitCallProps {
  readonly connected: boolean;
  readonly getBundle: () => ProvidersBundle | undefined;
}

/**
 * Circuit call UI for the preprod ZKEventAccess contract.
 *
 * - Proofs are generated locally in the browser (WASM prover)
 * - Only proofs + public effects are submitted on-chain
 * - Private inputs (the organizer secret key) never appear in this UI
 */
export const CircuitCall: React.FC<CircuitCallProps> = ({ connected, getBundle }) => {
  const [api, setApi] = useState<CounterAPI | undefined>(undefined);
  const [ledger, setLedger] = useState<CounterLedgerState | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | undefined>(undefined);

  // Subscribe to the public ledger state once joined.
  useEffect(() => {
    if (!api) return;
    const sub = api.state$.subscribe({
      next: (s) => setLedger(s),
      error: (e) => setMessage(`Ledger subscription failed: ${String(e)}`),
    });
    return () => sub.unsubscribe();
  }, [api]);

  const join = async (): Promise<CounterAPI> => {
    if (api) return api;
    setPhase('joining');
    setMessage('Joining the preprod contract…');
    const bundle = getBundle();
    if (!bundle) throw new Error('Wallet is not connected.');
    const joined = await CounterAPI.join(bundle.providers, CONTRACT_ADDRESS);
    setApi(joined);
    setMessage(undefined);
    setPhase('idle');
    return joined;
  };

  const runCircuit = async (name: 'increment' | 'read') => {
    try {
      const counterApi = await join();
      setPhase('proving');
      setMessage(`Generating ZK proof locally (${name}) — this runs in your browser…`);
      if (name === 'increment') await counterApi.increment();
      else await counterApi.read();
      setPhase('done');
      setMessage(`✅ Transaction finalized on ${NETWORK_ID}. Counter refreshes from the chain below.`);
    } catch (err) {
      setPhase('error');
      const raw = err instanceof Error ? err.message : String(err);
      setMessage(
        /assert/i.test(raw)
          ? `⛔ Proof rejected locally: you are not this event's organizer. (${raw})`
          : `Error: ${raw}`,
      );
    }
  };

  const busy = phase === 'proving' || phase === 'joining';

  return (
    <section style={styles.card}>
      <h2 style={styles.title}>EVENT ACCESS CREDENTIALS</h2>
      <div style={styles.label}>Public on-chain credential count</div>
      <div style={styles.counter}>{ledger ? ledger.counter.toString() : '—'}</div>
      {ledger && (
        <div style={styles.label}>
          Latest announcement: <em>{ledger.announcement || '(none)'}</em>
        </div>
      )}

      <div style={styles.buttonRow}>
        <button
          style={{ ...styles.button, ...(busy ? styles.buttonDisabled : {}) }}
          disabled={!connected || busy}
          onClick={() => runCircuit('increment')}
          title="Organizer-only circuit"
        >
          Issue credential (+1)
        </button>
        <button
          style={{ ...styles.button, ...styles.buttonSecondary, ...(busy ? styles.buttonDisabled : {}) }}
          disabled={!connected || busy}
          onClick={() => runCircuit('read')}
        >
          Verify access (read)
        </button>
      </div>

      <div style={styles.privacyNote}>
        🔒 Proved without revealing your input — the organizer secret key never leaves this device.
      </div>

      {!connected && <p style={{ ...styles.status, color: '#8b949e' }}>Connect your wallet to call circuits.</p>}
      {message && (
        <p
          style={{
            ...styles.status,
            ...(phase === 'error' ? styles.err : phase === 'done' ? styles.ok : styles.busy),
          }}
        >
          {phase === 'proving' && '⏳ '}
          {message}
        </p>
      )}
    </section>
  );
};
