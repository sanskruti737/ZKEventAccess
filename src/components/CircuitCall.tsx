import React, { useEffect, useState } from 'react';
import { CounterAPI, type CounterLedgerState } from '../midnight/counter-api';
import { NETWORK_ID } from '../midnight/providers';
import type { ProvidersBundle } from '../midnight/providers';

/** Public (non-secret) contract address of an event deployed from this browser. */
const DEPLOYED_CONTRACT_ADDRESS_KEY = 'zkEventAccess.deployedContractAddress';

const isValidAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^(0x)?[0-9a-fA-F]{24,128}$/.test(value.trim());

/**
 * Returns the active event address from localStorage (set by a prior successful
 * deploy from this browser).  There is NO `.env` / VITE fallback — the old
 * CLI-owned event was never registered to any 1AM wallet and can never pass the
 * organizer assert, so using it as a default would always produce a hard failure.
 * The user must deploy a new event before Issue / Verify can work.
 */
const resolveContractAddress = (): string | undefined => {
  try {
    const stored = window.localStorage.getItem(DEPLOYED_CONTRACT_ADDRESS_KEY);
    if (stored && isValidAddress(stored)) return stored.trim();
  } catch {
    // storage unavailable — no deployed event yet
  }
  return undefined;
};

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
  const [activeAddress, setActiveAddress] = useState<string | undefined>(() => resolveContractAddress());

  useEffect(() => {
    if (!api) return;
    const sub = api.state$.subscribe({
      next: (s) => {
        setLedger(s);
        console.debug('[debug] active event:', String(api.contractAddress), 'on-chain organizer:', s.organizer);
      },
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
    // The current active event is whatever was deployed/joined in this session;
    // fall back to a previously deployed address persisted from this browser.
    const contractAddress = activeAddress ?? resolveContractAddress();
    if (!contractAddress) {
      throw new Error(
        'No event contract address configured. Click "Deploy new event (organizer)" so this wallet becomes the on-chain organizer.',
      );
    }
    const joined = await CounterAPI.join(bundle.providers, contractAddress);
    console.log('[debug] joined event contract address:', String(joined.contractAddress));
    console.log('[debug] connected wallet:', bundle.walletName, 'shieldedAddress:', bundle.address);
    setApi(joined);
    setActiveAddress(String(joined.contractAddress));
    setMessage(undefined);
    setPhase('idle');
    return joined;
  };

  const runCircuit = async (name: 'increment' | 'read') => {
    try {
      const counterApi = await join();
      setPhase('proving');
      setMessage(`Generating ZK proof locally (${name}) — this runs in your browser…`);
      if (name === 'increment') {
        await counterApi.increment();
        setLedger(await counterApi.readLatest());
      } else {
        await counterApi.read();
      }
      setPhase('done');
      setMessage(`Transaction finalized on ${NETWORK_ID}. Counter refreshes from the chain below.`);
    } catch (err) {
      setPhase('error');
      const raw = err instanceof Error ? err.message : String(err);
      setMessage(
        /organizer authorization failed/i.test(raw)
          ? raw
          : /assert/i.test(raw)
            ? `Access issuance was rejected on-chain on event ${activeAddress ?? '(configured event)'}: the connected 1AM wallet is not the registered organizer of this event, and only the organizer can issue access. Register this wallet as the organizer by clicking "Deploy new event (organizer)", then Issue again. No key is ever entered or stored. ({${raw}})`
            : `error: ${raw}`,
      );
    }
  };

  const deployNewEvent = async () => {
    try {
      const bundle = getBundle();
      if (!bundle) throw new Error('Wallet is not connected.');
      setPhase('proving');
      setMessage(
        'Submitting a new event deployment through the connected 1AM wallet, then waiting for on-chain inclusion and ' +
          'verifying this wallet is the registered organizer…',
      );
      const deployed = await CounterAPI.deployNew(bundle.providers, undefined, (address) => {
        // The deployment transaction has already been finalized on-chain — this
        // is the REAL new address. Persist it the moment we know it, so a lagging
        // indexer read can never cause the freshly deployed event to be lost.
        try {
          window.localStorage.setItem(DEPLOYED_CONTRACT_ADDRESS_KEY, address);
        } catch {
          // storage unavailable — in-session event still switches below
        }
        setActiveAddress(address);
      });
      console.log('[debug] deploy switched active event to:', String(deployed.contractAddress));
      setApi(deployed);
      setActiveAddress(String(deployed.contractAddress));
      try {
        window.localStorage.setItem(DEPLOYED_CONTRACT_ADDRESS_KEY, String(deployed.contractAddress));
      } catch {
        // storage unavailable — the in-session event is still switched; a later
        // session simply falls back to the configured event until re-deployed.
      }
      setPhase('done');
      setMessage(
        `New event deployed and VERIFIED on-chain as owned by this 1AM wallet (organizer commitment checked against the ` +
          `indexer state before switching). Contract address: ${String(deployed.contractAddress)}. This event is now ` +
          `active and remembered, so "Issue credential (+1)" will pass the on-chain organizer check.`,
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
      {activeAddress && (
        <div style={{ ...styles.label, marginTop: 6 }}>
          Active event: <code style={{ color: '#58a6ff', wordBreak: 'break-all', fontSize: 12 }}>{activeAddress}</code>
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
