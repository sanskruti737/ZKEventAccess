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
  buttonRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 18 },
  button: {
    padding: '10px 12px',
    borderRadius: 8,
    border: 'none',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    color: '#fff',
    background: '#238636',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
    textAlign: 'center' as const,
  },
  buttonSecondary: { background: '#1f6feb' },
  buttonDisabled: { opacity: 0.55, cursor: 'wait' },
  buttonTertiary: {
    background: '#1b3f6e',
    marginTop: 12,
    gridColumn: '1 / -1',
  },
  keySection: {
    marginTop: 16,
    padding: '12px 14px',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 8,
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

export const CircuitCall: React.FC<CircuitCallProps> = ({ connected, getBundle }) => {
  const [api, setApi] = useState<CounterAPI | undefined>(undefined);
  const [ledger, setLedger] = useState<CounterLedgerState | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | undefined>(undefined);

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
      setMessage(`Transaction finalized on ${NETWORK_ID}. Counter refreshes from the chain below.`);
    } catch (err) {
      setPhase('error');
      const raw = err instanceof Error ? err.message : String(err);
      setMessage(
        /organizer authorization failed/i.test(raw)
          ? raw
          : /assert/i.test(raw)
            ? `Access issuance was rejected on-chain: the connected 1AM wallet is not the registered organizer, and only the organizer can issue access on this event. Connect the 1AM wallet that is registered as the on-chain organizer, then try again. no key needs to be pasted or stored anywhere. ({${raw}})`
            : `error: ${raw}`,
      );
    }
  };

  const deployNewEvent = async () => {
    try {
      const bundle = getBundle();
      if (!bundle) throw new Error('Wallet is not connected.');
      setPhase('proving');
      setMessage('Deploying a new event with this wallet as organizer — proving and submitting on preprod…');
      const deployed = await CounterAPI.deployNew(bundle.providers);
      setApi(deployed);
      setPhase('done');
      setMessage(
        `New event deployed — this 1AM wallet owns its organizer identity (derived on demand, never stored). ` +
          `Contract address: ${String(deployed.contractAddress)}. Set VITE_CONTRACT_ADDRESS to this address and ` +
          `redeploy so the site permanently operates on this event.`,
      );
    } catch (err) {
      setPhase('error');
      setMessage(`error: ${err instanceof Error ? err.message : String(err)}`);
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
        <button
          style={{ ...styles.button, ...styles.buttonTertiary, ...(busy ? styles.buttonDisabled : {}) }}
          disabled={!connected || busy}
          onClick={() => deployNewEvent()}
          title="Organizer-only: deploy a new event whose organizer identity is created and held by this connected 1AM wallet session"
        >
          Deploy new event (organizer)
        </button>
      </div>

      <div style={styles.keySection}>
        <div style={{ color: '#9fb3c8', fontSize: 13, fontWeight: 600 }}>
          <span style={{ color: '#3fb950' }}>✓</span> Organizer authorization via 1AM Wallet
        </div>
        <div style={{ color: '#8b949e', fontSize: 12, marginTop: 4 }}>
          The organizer identity is verified on-chain through the connected 1AM wallet — and its secret key
          never leaves the wallet itself, so nothing to paste or store.
        </div>
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
