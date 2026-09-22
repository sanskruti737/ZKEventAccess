import React, { useEffect, useRef, useState } from 'react';
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

  // Per-action in-flight locks (duplicate-request fix). Each user action owns an
  // independent lock so that:
  //   - ONE user click (or one effect run) issues exactly ONE wallet request;
  //     a second click while the same action is pending is a harmless no-op.
  //   - Verify access (a pure read, organizer-free) stays clickable and
  //     functional even while an Issue request is pending — no shared `busy`
  //     flag can disable it.
  // The refs gate synchronous double-clicks; the `*Pending` state ONLY drives
  // button disabled/styling so React re-renders the controls.
  const issueInFlightRef = useRef(false);
  const readInFlightRef = useRef(false);
  const deployInFlightRef = useRef(false);
  const [issuePending, setIssuePending] = useState(false);
  const [readPending, setReadPending] = useState(false);
  const [deployPending, setDeployPending] = useState(false);

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

  // Auto-load the persisted event after a page refresh (or right after the
  // wallet connects): the address survives in localStorage, but the read-only
  // `api`/`state$` subscription must be re-established so the public on-chain
  // credential count renders without requiring a manual button click first.
  //
  // IMPORTANT (duplicate-request fix): this mount-time effect must NOT derive
  // the wallet organizer key. Derivation calls 1AM `signData`, which pops the
  // "Sign text-encoded data" approval — firing that automatically here (and
  // again on an Issue click) produced the "Duplicate request" 1AM error.
  // Ownership verification is therefore deferred to Issue time, where a single
  // in-flight derivation is shared and the cached session key is reused, so one
  // user click triggers exactly one wallet request.
  useEffect(() => {
    if (!connected || api) return;
    const bundle = getBundle();
    const contractAddress = resolveContractAddress();
    if (!bundle || !contractAddress) return;
    let cancelled = false;
    (async () => {
      try {
        const joined = await CounterAPI.join(bundle.providers, contractAddress);
        if (cancelled) return;
        void joined.readLatest().then((s) => {
          if (!cancelled) {
            setLedger(s);
            console.log(
              '[debug] auto-joined persisted event contract address:',
              String(joined.contractAddress),
              'on-chain organizer:',
              s.organizer,
            );
          }
        });
        setApi(joined);
        setActiveAddress(String(joined.contractAddress));
        setPhase('idle');
        setMessage(undefined);
      } catch (err) {
        if (cancelled) return;
        const raw = err instanceof Error ? err.message : String(err);
        // The persisted event is not (yet) on chain in this session — e.g. it
        // was deployed earlier but the indexer needs time, or the address was
        // changed externally. Keep it configured and guide the user; do not
        // silently wipe it on a transient indexer failure.
        setMessage(
          `Could not auto-load event ${contractAddress.slice(0, 12)}… — ${raw}. If this looks wrong, click ` +
            `"Deploy new event (organizer)" to register a fresh event for this wallet.`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, api, getBundle]);

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
    const inFlightRef = name === 'increment' ? issueInFlightRef : readInFlightRef;
    if (inFlightRef.current) return; // same action already in flight — ignore the duplicate click
    inFlightRef.current = true;
    if (name === 'increment') setIssuePending(true);
    else setReadPending(true);
    try {
      const bundle = getBundle();
      const counterApi = await join();
      setPhase('proving');
      setMessage(`Generating ZK proof locally (${name}) — this runs in your browser…`);
      if (name === 'increment') {
        // Pre-flight on-chain organizer check (requirement: never submit a
        // transaction that is guaranteed to revert). Read the event's registered
        // organizer commitment and compare it (case-insensitively) against the
        // connected wallet's derived identity. This mirrors the contract's own
        // `only the organizer can issue access` assert, but fails fast with a
        // clear message instead of spending a submit+fail cycle.
        if (bundle?.providers.organizerIdentity) {
          const [expectedOrganizer, onChainState] = await Promise.all([
            CounterAPI.currentOrganizerCommitment(bundle.providers).catch(() => undefined),
            counterApi.readLatest().catch(() => undefined),
          ]);
          const connected = expectedOrganizer?.toLowerCase();
          const registered = onChainState?.organizer.toLowerCase();
          console.log('[debug] pre-issue organizer check:');
          console.log('[debug]   connected wallet organizer commitment:', connected);
          console.log('[debug]   deployed event organizer commitment:', registered);
          console.log(
            '[debug]   organizer match:',
            connected && registered ? connected === registered : 'unreadable (skipping fail-fast, on-chain assert still enforces)',
          );
          if (connected && registered && connected !== registered) {
            setPhase('error');
            setMessage(
              `Access issuance was rejected BEFORE submission: the connected 1AM wallet is not the registered ` +
                `organizer of event ${onChainState ? String(counterApi.contractAddress).slice(0, 12) : '(configured)'}… ` +
                `(on-chain organizer ${registered} ≠ connected wallet ${connected}). Only the organizer may issue ` +
                `access. Click "Deploy new event (organizer)" to register a fresh event owned by this wallet — no ` +
                `key is ever entered or stored.`,
            );
            return;
          }
        }
        await counterApi.increment();
      } else {
        await counterApi.read();
      }
      setLedger(await counterApi.readLatest());
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
      } finally {
        inFlightRef.current = false;
        if (name === 'increment') setIssuePending(false);
        else setReadPending(false);
      }
  };

  const deployNewEvent = async () => {
    if (deployInFlightRef.current) return; // duplicate deploy click — no-op
    deployInFlightRef.current = true;
    setDeployPending(true);
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
      const raw = err instanceof Error ? err.message : String(err);
      const low =
        /insufficient|not enough|funds|balance|dust/i.test(raw) &&
        /rejected|denied|cancel/i.test(raw) === false;
      const rejected = /rejected|denied|user declined|abort|cancel/i.test(raw);
      setMessage(
        rejected
          ? `Deployment was not approved in the 1AM wallet (${raw}). Click "Deploy new event (organizer)" to try again when ready.`
          : low
            ? `Deployment failed: ${raw}. The 1AM wallet needs preprod funds (T$ and DUST) to finalize the deploy transaction. Fund it via the Midnight faucet, then press "Deploy new event (organizer)".`
            : `Deployment failed: ${raw}`,
      );
    } finally {
      deployInFlightRef.current = false;
      setDeployPending(false);
    }
  };

  // Per-action pending flags power the button disabled state. Issue and Deploy are
  // mutually exclusive (both submit wallet-backed transactions), while Verify
  // access is a pure read that stays clickable no matter what Issue/Deploy are
  // doing — it is only disabled while its own read request is in flight.
  const busy = issuePending || deployPending;

  // ── Automatic first-run deployment ───────────────────────────────────────────
  // Root-cause fix for "No event contract address configured": the app only ever
  // learned an event address from a successful in-browser deploy, but nothing
  // triggered that deploy except the manual button — so a fresh production
  // visitor was permanently stuck configuring nothing. Now, when an organizer
  // wallet connects and no event address is configured yet, we deploy one
  // automatically (still through the connected 1AM wallet, organizer bound to
  // that wallet, address persisted) so Issue/Verify work immediately.
  const autoDeployAttempted = useRef(false);
  useEffect(() => {
    if (!connected || api || autoDeployAttempted.current) return;
    const address = resolveContractAddress();
    if (address) return; // already configured — auto-join handles the rest
    const bundle = getBundle();
    if (!bundle) return;
    autoDeployAttempted.current = true;
    console.log('[debug] no event configured — auto-deploying a new event for the connected organizer wallet');
    void deployNewEvent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, api, getBundle]);

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
          {issuePending ? 'Issuing…' : 'Issue credential (+1)'}
        </button>
        <button
          style={{ ...styles.button, ...styles.buttonSecondary, ...(readPending ? styles.buttonDisabled : {}) }}
          disabled={!connected || readPending}
          onClick={() => runCircuit('read')}
        >
          {readPending ? 'Verifying…' : 'Verify access (read)'}
        </button>
        <button
          style={{ ...styles.button, ...styles.buttonTertiary, ...(busy ? styles.buttonDisabled : {}) }}
          disabled={!connected || busy}
          onClick={() => deployNewEvent()}
          title="Organizer-only: deploy a new event whose organizer identity is created and held by this connected 1AM wallet session"
        >
          {deployPending ? 'Deploying…' : 'Deploy new event (organizer)'}
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
