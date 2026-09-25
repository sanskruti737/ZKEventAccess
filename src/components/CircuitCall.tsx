import React, { useEffect, useRef, useState } from 'react';
import { ZKEventAccessAPI, type ZKEventAccessLedgerState } from '../midnight/zk-event-access-api';
import { NETWORK_ID } from '../midnight/providers';
import type { ProvidersBundle } from '../midnight/providers';
import {
  ActivityIcon,
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  GlobeIcon,
  KeyIcon,
  LoaderIcon,
  LockIcon,
  PlusIcon,
  RefreshIcon,
  ScanIcon,
  ShieldCheckIcon,
  SparklesIcon,
  WalletIcon,
} from './Icon';

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

const shortenAddress = (value: string): string => {
  if (value.length <= 26) return value;
  return `${value.slice(0, 14)}…${value.slice(-10)}`;
};

const formatUpdatedAt = (value: Date | undefined): string => {
  if (!value) return 'Waiting for the first public state';
  return `Updated ${value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

type Phase = 'idle' | 'joining' | 'proving' | 'done' | 'error';

export interface CircuitCallProps {
  readonly connected: boolean;
  readonly getBundle: () => ProvidersBundle | undefined;
}

export const CircuitCall: React.FC<CircuitCallProps> = ({ connected, getBundle }) => {
  const [api, setApi] = useState<ZKEventAccessAPI | undefined>(undefined);
  const [ledger, setLedger] = useState<ZKEventAccessLedgerState | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [activeAddress, setActiveAddress] = useState<string | undefined>(() => resolveContractAddress());
  const [lastUpdated, setLastUpdated] = useState<Date | undefined>(undefined);
  const [addressCopied, setAddressCopied] = useState(false);

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
        setLastUpdated(new Date());
        console.debug('[debug] active event:', String(api.contractAddress), 'on-chain organizer:', s.organizer);
      },
      error: (e) => {
        setPhase('error');
        setMessage(`Ledger subscription failed: ${String(e)}`);
      },
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
        const joined = await ZKEventAccessAPI.join(bundle.providers, contractAddress);
        if (cancelled) return;
        void joined.readLatest().then((s) => {
          if (!cancelled) {
            setLedger(s);
            setLastUpdated(new Date());
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
        setPhase('error');
        // The persisted event is not (yet) on chain in this session — e.g. it
        // was deployed earlier but the indexer needs time, or the address was
        // changed externally. Keep it configured and guide the user; do not
        // silently wipe it on a transient indexer failure.
        setMessage(
          `Could not auto-load event ${contractAddress.slice(0, 12)}… — ${raw}. If this looks wrong, click ` +
            `"Deploy a new wallet-backed event" to register a fresh event for this wallet.`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, api, getBundle]);

  const join = async (): Promise<ZKEventAccessAPI> => {
    // Always bind to the CURRENT active event (the most recent deploy wins).
    // Returning the cached `api` unconditionally is what caused the "still
    // rejected as organizer" reports after a new deploy: the address had been
    // switched to the fresh event but the stale ZKEventAccessAPI bound to the old
    // event was still returned, so the organizer comparison ran against the
    // WRONG contract. Re-join whenever the API's contract differs from the
    // active address (or when no API is materialized yet).
    const contractAddress = activeAddress ?? resolveContractAddress();
    if (!contractAddress) {
      throw new Error(
        'No event contract address configured. Click "Deploy a new wallet-backed event" so this wallet becomes the on-chain organizer.',
      );
    }
    if (api && String(api.contractAddress) === contractAddress) return api;
    setPhase('joining');
    setMessage('Joining the preprod contract…');
    const bundle = getBundle();
    if (!bundle) throw new Error('Wallet is not connected.');
    const joined = await ZKEventAccessAPI.join(bundle.providers, contractAddress);
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
      const eventAccessApi = await join();
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
            ZKEventAccessAPI.currentOrganizerCommitment(bundle.providers).catch(() => undefined),
            eventAccessApi.readLatest().catch(() => undefined),
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
                `organizer of event ${onChainState ? String(eventAccessApi.contractAddress).slice(0, 12) : '(configured)'}… ` +
                `(on-chain organizer ${registered} ≠ connected wallet ${connected}). Only the organizer may issue ` +
                `access. Click "Deploy a new wallet-backed event" to register a fresh event owned by this wallet — no ` +
                `key is ever entered or stored.`,
            );
            return;
          }
        }
        await eventAccessApi.increment();
      } else {
        await eventAccessApi.read();
      }
      setLedger(await eventAccessApi.readLatest());
      setLastUpdated(new Date());
      setPhase('done');
      setMessage(
        name === 'increment'
          ? `Transaction finalized on ${NETWORK_ID}. The public count is refreshed below.`
          : `Verification complete on ${NETWORK_ID}. The latest public state is shown below.`,
      );
    } catch (err) {
        setPhase('error');
        const raw = err instanceof Error ? err.message : String(err);
        setMessage(
          /organizer authorization failed/i.test(raw)
            ? raw
            : /assert/i.test(raw)
              ? `Access issuance was rejected on-chain on event ${activeAddress ?? '(configured event)'}: the connected 1AM wallet is not the registered organizer of this event, and only the organizer can issue access. Register this wallet as the organizer by clicking "Deploy a new wallet-backed event", then Issue again. No key is ever entered or stored. ({${raw}})`
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
    let switchedAddress: string | undefined;
    try {
      const bundle = getBundle();
      if (!bundle) throw new Error('Wallet is not connected.');
      setPhase('proving');
      setMessage(
        'Submitting a new event deployment through the connected 1AM wallet, then waiting for on-chain inclusion and ' +
          'verifying this wallet is the registered organizer…',
      );
      const deployed = await ZKEventAccessAPI.deployNew(bundle.providers, undefined, (address) => {
        // The deployment transaction has already been finalized on-chain — this
        // is the REAL new address. Persist it the moment we know it, so a lagging
        // indexer read can never cause the freshly deployed event to be lost.
        switchedAddress = address;
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
          `active and remembered, so "Issue credential" will pass the on-chain organizer check.`,
      );
    } catch (err) {
      setPhase('error');
      const raw = err instanceof Error ? err.message : String(err);
      const low =
        /insufficient|not enough|funds|balance|dust/i.test(raw) &&
        /rejected|denied|cancel/i.test(raw) === false;
      const rejected = /rejected|denied|user declined|abort|cancel/i.test(raw);
      if (switchedAddress) {
        // The deploy DID finalize on-chain and the address was persisted+activated,
        // but the post-finalization organizer-verification read failed/timed out.
        // Bind the live `api` to the NEW event right now so a following Issue click
        // runs against the fresh event (not the stale one the pre-flight previously
        // compared against) while still surfacing the verification error message.
        try {
          setActiveAddress(switchedAddress);
          const rebindBundle = getBundle();
          if (rebindBundle) {
            const joined = await ZKEventAccessAPI.join(rebindBundle.providers, switchedAddress);
            console.log('[debug] rebound api to newly deployed event:', switchedAddress);
            setApi(joined);
          }
        } catch (rebindErr) {
          console.warn('[debug] rebind to newly deployed event failed:', String(rebindErr));
        }
      }
      setMessage(
        rejected
          ? `Deployment was not approved in the 1AM wallet (${raw}). Click "Deploy a new wallet-backed event" to try again when ready.`
          : low
            ? `Deployment failed: ${raw}. The 1AM wallet needs preprod funds (T$ and DUST) to finalize the deploy transaction. Fund it via the Midnight faucet, then press "Deploy a new wallet-backed event".`
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

  const copyActiveAddress = async () => {
    if (!activeAddress) return;
    try {
      await navigator.clipboard.writeText(activeAddress);
      setAddressCopied(true);
      window.setTimeout(() => setAddressCopied(false), 1800);
    } catch {
      setAddressCopied(false);
    }
  };

  const hasEvent = Boolean(activeAddress || api);
  const isWorking = busy || phase === 'joining' || phase === 'proving';
  const statusTone = phase === 'error' ? 'error' : phase === 'done' ? 'success' : phase === 'idle' ? 'neutral' : 'working';
  const statusTitle =
    phase === 'error'
      ? 'We could not complete that action'
      : phase === 'done'
        ? 'Action complete'
        : phase === 'joining' || phase === 'proving'
          ? 'Working securely'
          : !connected
            ? 'Connect your wallet to continue'
            : hasEvent
              ? 'Ready for the next action'
              : 'Preparing your first event';
  const statusBody =
    message ??
    (phase === 'error'
      ? 'Review the message above, then try again or open a fresh event.'
      : phase === 'done'
        ? 'The public ledger is refreshed below.'
        : phase === 'joining' || phase === 'proving'
          ? 'Keep this tab open while the wallet and network complete the request.'
          : !connected
            ? 'Your organizer identity stays in the wallet; no secret key is pasted into this app.'
            : hasEvent
              ? 'Issue a credential for an authorized organizer or verify the current public count.'
              : 'Connect an organizer wallet to create a private, wallet-backed event.');

  return (
    <section className="surface-card" id="access-ledger" aria-labelledby="event-title" aria-busy={isWorking}>
      <div className="card-header event-header">
        <span className="section-index" aria-hidden="true">02</span>
        <div className="card-header-copy">
          <div className="section-kicker">Access ledger</div>
          <h2 className="card-title" id="event-title">Event credentials</h2>
          <p className="card-description">Issue authorized access, then verify the public count without exposing the people behind it.</p>
        </div>
        <span className={`status-chip ${ledger ? 'status-chip-success' : hasEvent ? 'status-chip-warning' : ''}`}>
          <span className="status-dot" aria-hidden="true" />
          {ledger ? 'Synced' : hasEvent ? 'Connecting' : 'No event'}
        </span>
      </div>

      <div className="event-body">
        <div className="event-overview">
          <div className="metric-card">
            <div className="metric-top">
              <span className="metric-label">Public credential count</span>
              <ActivityIcon />
            </div>
            <div className="metric-value" aria-live="polite">{ledger ? ledger.counter.toString() : '—'}</div>
            <div className="metric-caption">Accesses currently recorded on Midnight.</div>
            <div className="updated-label">
              <RefreshIcon />
              {formatUpdatedAt(lastUpdated)}
            </div>
          </div>

          <div className="context-card" aria-label="Event context">
            <div className="context-row">
              <span className="context-label">Network</span>
              <span className="context-value"><strong>{NETWORK_ID}</strong></span>
            </div>
            <div className="context-row">
              <span className="context-label">Organizer</span>
              <span className="context-value"><strong>{connected ? '1AM wallet' : 'Not connected'}</strong></span>
            </div>
            <div className="context-row">
              <span className="context-label">Announcement</span>
              <span className="context-value">{ledger?.announcement || 'No announcement yet'}</span>
            </div>
          </div>
        </div>

        {activeAddress ? (
          <div className="event-address-row">
            <div className="address-block">
              <span className="address-label">Active event address</span>
              <div className="address-row">
                <code title={activeAddress}>{shortenAddress(activeAddress)}</code>
                <button className="icon-button" type="button" onClick={copyActiveAddress} aria-label="Copy active event address" title="Copy event address">
                  {addressCopied ? <CheckIcon /> : <CopyIcon />}
                </button>
              </div>
            </div>
            <span className="status-chip status-chip-success"><span className="status-dot" aria-hidden="true" /> Wallet-backed</span>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true"><GlobeIcon /></div>
            <div className="empty-state-copy">
              <h3 className="empty-state-title">No event loaded yet</h3>
              <p>Connect an organizer wallet to create your first private event, or wait while the app prepares it.</p>
            </div>
          </div>
        )}

        <div className="action-section">
          <div className="action-section-heading">
            <div>
              <h3>Manage access</h3>
              <p>Each action stays explicit and auditable.</p>
            </div>
            <span className="action-hint"><LockIcon /> Proofs stay private</span>
          </div>
          <div className="action-grid">
            <button
              className="action-card action-card-primary"
              type="button"
              disabled={!connected || busy}
              onClick={() => runCircuit('increment')}
              title="Organizer-only circuit"
            >
              <span className="action-card-icon" aria-hidden="true"><PlusIcon /></span>
              <span className="action-card-copy">
                <span className="action-card-title">Issue credential</span>
                <span className="action-card-description">Organizer-only · adds one access</span>
              </span>
              <span className="action-card-arrow" aria-hidden="true"><ChevronRightIcon /></span>
            </button>
            <button
              className="action-card action-card-secondary"
              type="button"
              disabled={!connected || readPending}
              onClick={() => runCircuit('read')}
            >
              <span className="action-card-icon" aria-hidden="true"><ScanIcon /></span>
              <span className="action-card-copy">
                <span className="action-card-title">Verify access</span>
                <span className="action-card-description">Read the public ledger count</span>
              </span>
              <span className="action-card-arrow" aria-hidden="true"><ChevronRightIcon /></span>
            </button>
          </div>
          <button
            className="deploy-button"
            type="button"
            disabled={!connected || busy}
            onClick={() => deployNewEvent()}
            title="Organizer-only: deploy a new event whose organizer identity is held by this wallet"
          >
            <SparklesIcon />
            <span>{deployPending ? 'Deploying and verifying event…' : 'Deploy a new wallet-backed event'}</span>
            <ChevronRightIcon className="action-card-arrow" />
          </button>
        </div>

        <div className="organizer-panel">
          <div className="organizer-panel-icon" aria-hidden="true"><KeyIcon /></div>
          <div className="organizer-panel-copy">
            <h3 className="organizer-panel-title">Organizer authorization</h3>
            <p>1AM wallet authority is checked when you issue or deploy. No organizer key is pasted, displayed, or stored in this interface.</p>
          </div>
          <span className="organizer-panel-badge">
            {connected ? <><ShieldCheckIcon /> Ready to verify</> : <><LockIcon /> Connect first</>}
          </span>
        </div>

        <div
          className={`status-panel status-panel-${statusTone}`}
          role={phase === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          <div className="status-panel-icon" aria-hidden="true">
            {phase === 'error' ? <AlertIcon /> : phase === 'done' ? <CheckIcon /> : isWorking ? <LoaderIcon /> : <ActivityIcon />}
          </div>
          <div className="status-panel-copy">
            <span className="status-overline">{phase === 'error' ? 'Action needs attention' : phase === 'done' ? 'Ledger updated' : 'Current status'}</span>
            <strong className="status-title">{statusTitle}</strong>
            <p className="status-message">{statusBody}</p>
          </div>
        </div>

        {!connected && (
          <div className="connect-prompt" role="status">
            <WalletIcon />
            Connect 1AM above to unlock issue, deploy, and verify actions.
          </div>
        )}
      </div>
    </section>
  );
};
