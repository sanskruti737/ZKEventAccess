import React, { useEffect, useRef, useState } from 'react';
import { ZKEventAccessAPI, type ZKEventAccessLedgerState } from '../midnight/zk-event-access-api';
import { NETWORK_ID } from '../midnight/providers';
import type { ProvidersBundle } from '../midnight/providers';
import {
  clearStoredActiveEventAddress,
  isOrganizerMismatch,
  isStaleContractBuildError,
  organizerMismatchMessage,
  readStoredActiveEventOrganizer,
  readStoredActiveEventAddress,
  staleContractBuildCircuits,
  staleContractBuildMessage,
  writeStoredActiveEvent,
  writeStoredActiveEventAddress,
} from '../midnight/active-event';
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

/**
 * Returns the active event address remembered by this browser (set by a prior
 * successful deploy).  There is NO `.env` / VITE fallback — the old CLI-owned
 * event was never registered to any 1AM wallet and can never pass the organizer
 * assert, so using it as a default would always produce a hard failure.
 */
const resolveContractAddress = (): string | undefined => readStoredActiveEventAddress();

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
  // Guards the one automatic redeploy per session, so a failing redeploy can
  // never loop. Reset whenever a genuinely new deployment succeeds.
  const autoRedeployRef = useRef(false);
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
        const joinedAddress = String(joined.contractAddress);
        const state = await joined.readLatest();
        if (cancelled) return;
        // Ownership is validated here using the PUBLIC organizer commitment that
        // was recorded when this event was deployed. This costs no wallet
        // prompt, and it stops the app from ever reading or issuing against an
        // event this wallet does not own. Events saved before that commitment
        // was recorded have none, so they are still checked at Issue time.
        const recordedOrganizer = readStoredActiveEventOrganizer();
        if (isOrganizerMismatch(recordedOrganizer, state.organizer)) {
          recoverFromForeignOrganizer(joinedAddress, state.organizer, recordedOrganizer!);
          return;
        }
        setLedger(state);
        setLastUpdated(new Date());
        console.log(
          '[debug] auto-joined persisted event contract address:',
          joinedAddress,
          'on-chain organizer:',
          state.organizer,
        );
        setApi(joined);
        setActiveAddress(joinedAddress);
        setPhase('idle');
        setMessage(undefined);
      } catch (err) {
        if (cancelled) return;
        // A persisted event from a DIFFERENT contract build can never be called
        // by this client — that is a permanent incompatibility, not a transient
        // indexer hiccup, so it is handled by the redeploy path below.
        if (isStaleContractBuildError(err)) {
          console.warn(
            '[stale-build] persisted event was deployed from a different contract build; unsetting it and redeploying',
            contractAddress,
            staleContractBuildCircuits(err),
          );
          recoverFromStaleEvent(err, contractAddress);
          return;
        }
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

  /**
   * Root-cause recovery for an event deployed from a DIFFERENT contract build.
   *
   * Such an event is permanently uncallable by this client: the instance
   * registered the verifier keys of the build that created it, and midnight-js
   * contracts refuses the join ("... are undefined or have mismatched verifier
   * keys ..."). Retrying, re-joining or re-proving can never fix it — only a new
   * deployment from the CURRENT artifacts can. So the dead address is dropped
   * (it is worthless to this build) and the app redeploys through the connected
   * 1AM wallet, exactly as it does for a first-time visitor. The failure is
   * reported truthfully in the UI, both before and after the redeploy attempt.
   */
  const recoverFromStaleEvent = (err: unknown, address: string): void => {
    abandonActiveEvent(staleContractBuildMessage(address, staleContractBuildCircuits(err)));
  };

  /**
   * The active event is unusable for this wallet, for one of two verified
   * reasons. Either way the ONLY correct outcome is a new wallet-backed
   * deployment: the stored address is dropped, the in-memory binding is
   * released so no action can read the dead event, and a real redeploy is
   * started through the connected 1AM wallet. The failure is always reported
   * truthfully and never counted as a success.
   */
  const abandonActiveEvent = (explanation: string): void => {
    clearStoredActiveEventAddress();
    setActiveAddress(undefined);
    setApi(undefined);
    setLedger(undefined);
    setPhase('error');
    setMessage(explanation);
    if (autoRedeployRef.current) return; // one automatic redeploy per session
    autoRedeployRef.current = true;
    void deployNewEvent(
      'The previously active event could not be used by this wallet, so it was replaced.',
    );
  };

  /**
   * On-chain organizer of the active event belongs to a different wallet, so
   * this wallet can never increment on it. Drop it and redeploy.
   */
  const recoverFromForeignOrganizer = (address: string, onChain: string, expected: string): void => {
    console.warn(
      '[organizer-mismatch] active event is owned by another organizer; unsetting it and redeploying',
      address,
      onChain,
      expected,
    );
    abandonActiveEvent(organizerMismatchMessage(address, onChain, expected));
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
          const activeEventAddress = String(eventAccessApi.contractAddress);
          const [expectedOrganizer, onChainState] = await Promise.all([
            ZKEventAccessAPI.currentOrganizerCommitment(bundle.providers, activeEventAddress).catch(() => undefined),
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
          if (isOrganizerMismatch(expectedOrganizer, onChainState?.organizer)) {
            recoverFromForeignOrganizer(activeEventAddress, onChainState!.organizer, expectedOrganizer!);
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
        // A stale-build event fails here too (join() throws ContractTypeError).
        // That is not an authorization problem and not something a retry can fix:
        // hand it to the redeploy path instead of reporting a misleading error.
        if (isStaleContractBuildError(err)) {
          console.warn('[stale-build] active event was deployed from a different contract build', err);
          recoverFromStaleEvent(err, activeAddress ?? resolveContractAddress() ?? 'the saved event');
          return;
        }
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

  /**
   * Deploys a new event instance from the CURRENT compiled artifacts through the
   * connected 1AM wallet (the organizer's key is derived from the wallet and never
   * entered or stored anywhere). `note` prepends the reason when this runs as an
   * automatic recovery rather than a direct button press.
   */
  const deployNewEvent = async (note?: string) => {
    if (deployInFlightRef.current) return; // duplicate deploy click — no-op
    deployInFlightRef.current = true;
    setDeployPending(true);
    let switchedAddress: string | undefined;
    try {
      const bundle = getBundle();
      if (!bundle) throw new Error('Wallet is not connected.');
      setPhase('proving');
      setMessage(
        (note ? `${note} ` : '') +
          'Submitting a new event deployment through the connected 1AM wallet, then waiting for on-chain inclusion and ' +
          'verifying this wallet is the registered organizer…',
      );
      const deployed = await ZKEventAccessAPI.deployNew(bundle.providers, undefined, (address) => {
        // The deployment transaction has already been finalized on-chain — this
        // is the REAL new address. Persist it the moment we know it, so a lagging
        // indexer read can never cause the freshly deployed event to be lost.
        switchedAddress = address;
        writeStoredActiveEventAddress(address);
        setActiveAddress(address);
      });
      console.log('[debug] deploy switched active event to:', String(deployed.contractAddress));
      const newAddress = String(deployed.contractAddress);
      setApi(deployed);
      setActiveAddress(newAddress);
      // Record the verified on-chain organizer commitment alongside the address
      // so later loads can validate ownership without another wallet prompt.
      const verifiedOrganizer = await ZKEventAccessAPI.currentOrganizerCommitment(bundle.providers, newAddress)
        .catch(() => undefined);
      writeStoredActiveEvent(newAddress, verifiedOrganizer ?? '');
      autoRedeployRef.current = false; // a fresh, working event: allow one future recovery
      setPhase('done');
      setMessage(
        (note ? `${note} ` : '') +
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
        (note ? `${note} ` : '') +
          (rejected
            ? `Deployment was not approved in the 1AM wallet (${raw}). Click "Deploy a new wallet-backed event" to try again when ready.`
            : low
              ? `Deployment failed: ${raw}. The 1AM wallet needs preprod funds (T$ and DUST) to finalize the deploy transaction. Fund it via the Midnight faucet, then press "Deploy a new wallet-backed event".`
              : `Deployment failed: ${raw}`),
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
