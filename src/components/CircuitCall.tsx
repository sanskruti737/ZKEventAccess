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
  keySection: {
    marginTop: 16,
    padding: '12px 14px',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 8,
  },
  keyInput: {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid #30363d',
    background: '#161b22',
    color: '#e6edf3',
    fontFamily: 'monospace',
    fontSize: 12,
    marginTop: 6,
    boxSizing: 'border-box' as const,
  },
  keyButton: {
    padding: '6px 14px',
    borderRadius: 6,
    border: 'none',
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
    color: '#fff',
    background: '#1f6feb',
    marginTop: 8,
  },
};

type Phase = 'idle' | 'joining' | 'proving' | 'done' | 'error';

export interface CircuitCallProps {
  readonly connected: boolean;
  readonly getBundle: () => ProvidersBundle | undefined;
}

const STORAGE_KEY = 'zkea.organizerKey';
const HEX64 = /^[0-9a-fA-F]{64}$/;

export const CircuitCall: React.FC<CircuitCallProps> = ({ connected, getBundle }) => {
  const [api, setApi] = useState<CounterAPI | undefined>(undefined);
  const [ledger, setLedger] = useState<CounterLedgerState | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [hasKey, setHasKey] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== null && HEX64.test(stored);
  });
  const [keyInput, setKeyInput] = useState('');

  useEffect(() => {
    if (!api) return;
    const sub = api.state$.subscribe({
      next: (s) => setLedger(s),
      error: (e) => setMessage(`Ledger subscription failed: ${String(e)}`),
    });
    return () => sub.unsubscribe();
  }, [api]);

  const saveKey = () => {
    const trimmed = keyInput.trim();
    if (!HEX64.test(trimmed)) {
      setMessage('Key must be exactly 64 hexadecimal characters (32 bytes).');
      setPhase('error');
      return;
    }
    localStorage.setItem(STORAGE_KEY, trimmed);
    window.location.reload();
  };

  const clearKey = () => {
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  };

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
        /assert/i.test(raw)
          ? `Assertion failed: your local organizer key does not match the on-chain key. Paste the correct 64-hex key in the field below. (${raw})`
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

      <div style={styles.keySection}>
        <div style={{ color: '#9fb3c8', fontSize: 13, fontWeight: 600 }}>
          Organizer Secret Key {hasKey ? '(set)' : '(not set)'}
        </div>
        <div style={{ color: '#8b949e', fontSize: 12, marginTop: 4 }}>
          Paste the 64-char hex key from <code>.organizer-key</code> to issue credentials.
        </div>
        {!hasKey ? (
          <>
            <input
              style={styles.keyInput}
              placeholder="64-char hex secret key (e.g. from .organizer-key)"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <button style={styles.keyButton} onClick={saveKey}>Save Key</button>
          </>
        ) : (
          <button
            style={{ ...styles.keyButton, background: '#da3633' }}
            onClick={clearKey}
          >
            Clear Key
          </button>
        )}
      </div>

      <div style={styles.privacyNote}>
        Proved without revealing your input — the organizer secret key never leaves this device.
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
