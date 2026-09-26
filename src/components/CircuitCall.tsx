import React, { useEffect, useRef, useState } from 'react';
import {
  OrganizerIdentityUnavailableError,
  OrganizerKeyPersistenceError,
  OrganizerUnverifiedError,
  OrganizerVerificationError,
  ZKEventAccessAPI,
  type ZKEventAccessLedgerState,
} from '../midnight/zk-event-access-api';
import { NETWORK_ID } from '../midnight/providers';
import type { ProvidersBundle } from '../midnight/providers';
import { watchWalletTxState, type WalletTxState, type WalletTxWatcher } from '../midnight/wallet-transactions';
import {
  activeEventNotPersistedMessage,
  FOREIGN_ORGANIZER_HEADLINE,
  invalidateActiveEvent,
  isActiveEventDurable,
  isStaleContractBuildError,
  isTransactionPendingError,
  organizerMismatchMessage,
  readActiveEventRecord,
  readVerifiedActiveEventAddress,
  recordUnverifiedDeployment,
  recordVerifiedActiveEvent,
  requireVerifiedActiveEvent,
  staleContractBuildCircuits,
  staleContractBuildMessage,
  transactionPendingMessage,
  type ActiveEventRecord,
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
 * The active event is whatever the local state machine says it is — never a
 * build-time `VITE_CONTRACT_ADDRESS`. An address that was deployed but never
 * verified against the connected wallet is deliberately NOT returned here, so
 * Issue credential and Verify access can never end up on a foreign event.
 */
const resolveVerifiedAddress = (): string | undefined => {
  const gate = requireVerifiedActiveEvent(readActiveEventRecord());
  return gate.ok ? gate.address : undefined;
};

const shortenAddress = (value: string): string => {
  if (value.length <= 26) return value;
  return `${value.slice(0, 14)}…${value.slice(-10)}`;
};

const formatUpdatedAt = (value: Date | undefined): string => {
  if (!value) return 'Waiting for the first public state';
  return `Updated ${value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

type Phase = 'idle' | 'joining' | 'proving' | 'done' | 'error' | 'needs-event';

/**
 * The deployment finalized, its organizer matched, but the active-event store
 * does not return the new address. This is the one case the flow must never
 * paper over: claiming success here is what made the app tell a wallet that
 * owns a live on-chain event that it had "no event contract address
 * configured" — sending it to pay for a second, duplicate deployment.
 */
export class ActiveEventActivationError extends Error {
  constructor(readonly address: string) {
    super(
      `The new event ${address} is on-chain and its organizer was verified, but this browser could not record it ` +
        `as the active event, so "Issue credential" and "Verify access" cannot use it. The deployment was NOT ` +
        `wasted — the event exists and is owned by this wallet — but this app cannot remember it. Allow site ` +
        `storage for this app (and avoid private/incognito windows or a full disk), then click "Deploy a new ` +
        `wallet-backed event" once more.`,
    );
    this.name = 'ActiveEventActivationError';
  }
}

/**
 * The action needs a verified active event that this browser does not have.
 *
 * Deliberately its own type so the UI can present it as a state to move on from
 * — with the deploy action offered — instead of as a failed action wrapped in
 * "error: …", which is how "you have not deployed yet" reached users looking
 * like a malfunction.
 */
export class NeedsActiveEventError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'NeedsActiveEventError';
  }
}

export interface CircuitCallProps {
  readonly connected: boolean;
  readonly getBundle: () => ProvidersBundle | undefined;
}

export const CircuitCall: React.FC<CircuitCallProps> = ({ connected, getBundle }) => {
  const [api, setApi] = useState<ZKEventAccessAPI | undefined>(undefined);
  const [ledger, setLedger] = useState<ZKEventAccessLedgerState | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [activeAddress, setActiveAddress] = useState<string | undefined>(() => resolveVerifiedAddress());
  const [lastUpdated, setLastUpdated] = useState<Date | undefined>(undefined);
  const [addressCopied, setAddressCopied] = useState(false);

  // The WALLET's transaction queue, which is a strictly larger window than this
  // app's own in-flight requests: `submitTransaction` resolves when the wallet
  // accepts a submission, not when it is included in a block. Until this is
  // observed, Issue and Deploy stay disabled even though nothing here is
  // awaiting a promise — which is exactly the window in which the wallet used to
  // answer a new request with "A transaction is already pending".
  const [walletTxState, setWalletTxState] = useState<WalletTxState>('unknown');
  const walletTxWatcherRef = useRef<WalletTxWatcher | undefined>(undefined);

  /** Re-reads the wallet queue now; awaited nowhere so it can never block an action. */
  const refreshWalletTxState = (): Promise<WalletTxState> =>
    walletTxWatcherRef.current?.refresh() ?? Promise.resolve(walletTxState);

  // Observe the wallet's queue for as long as a wallet is connected. This is
  // read-only: it never submits, retries or replaces a transaction, and it only
  // polls while something is actually pending.
  useEffect(() => {
    if (!connected) return;
    const connectedAPI = getBundle()?.connectedAPI;
    if (!connectedAPI) return;
    const watcher = watchWalletTxState(connectedAPI, setWalletTxState);
    walletTxWatcherRef.current = watcher;
    return () => {
      watcher.stop();
      walletTxWatcherRef.current = undefined;
    };
  }, [connected, getBundle]);

  // Per-action in-flight locks (duplicate-request fix). Each user action owns an
  // independent lock so that:
  //   - ONE user click (or one effect run) issues exactly ONE wallet request;
  //     a second click while the same action is pending is a harmless no-op.
  //   - the locks stay per-action so a finished action releases only itself.
  //
  // They are NOT a substitute for the shared lock below: a transaction stays
  // pending in the WALLET long after these promises settle, so the authoritative
  // gate for submitting is `walletTxState`, not these flags.
  // The refs gate synchronous double-clicks; the `*Pending` state ALSO drives
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
      },
      error: (e) => {
        setPhase('error');
        setMessage(`Ledger subscription failed: ${String(e)}`);
      },
    });
    return () => sub.unsubscribe();
  }, [api]);

  // Restore the VERIFIED event after a page refresh. Only a `verified` record is
  // restored: an event that was deployed but never verified against this wallet
  // is left inactive, and one invalidated for a foreign organizer or a stale
  // contract build is reported instead of being silently swapped for another
  // event.
  //
  // IMPORTANT (duplicate-request fix): this mount-time effect must NOT derive
  // the wallet organizer key. Derivation calls 1AM `signData`, which pops the
  // "Sign text-encoded data" approval — firing that automatically here (and
  // again on an Issue click) produced the "Duplicate request" 1AM error. The
  // re-verification below reuses the key already persisted in IndexedDB, so a
  // refresh never pops a second wallet prompt for the same wallet.
  useEffect(() => {
    if (!connected || api) return;
    const bundle = getBundle();
    const record = readActiveEventRecord();
    if (!bundle) return;
    if (!record) return; // nothing stored — Issue/Verify will ask for a deploy
    if (record.status !== 'verified') {
      const gate = requireVerifiedActiveEvent(record);
      setApi(undefined);
      setActiveAddress(undefined);
      setLedger(undefined);
      setPhase('error');
      setMessage(gate.ok ? undefined : gate.message);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const joined = await ZKEventAccessAPI.join(bundle.providers, record.address);
        if (cancelled) return;
        const joinedAddress = String(joined.contractAddress);

        // Re-check ownership against the CHAIN on every restore. The stored
        // commitment proves what was verified at deploy time; comparing it with
        // the live on-chain `organizer` also catches an event that was rotated
        // or replaced since. Both sides come from the same canonical formula.
        const [expectedOrganizer, onChainState] = await Promise.all([
          ZKEventAccessAPI.currentOrganizerCommitment(bundle.providers).catch(() => undefined),
          joined.readLatest().catch(() => undefined),
        ]);
        if (cancelled) return;
        if (!expectedOrganizer || !onChainState) {
          throw new Error(
            `Could not re-verify the organizer of event ${joinedAddress.slice(0, 12)}… with the connected 1AM wallet. ` +
              `If this persists, click "Deploy a new wallet-backed event".`,
          );
        }
        if (expectedOrganizer.toLowerCase() !== onChainState.organizer.toLowerCase()) {
          markEventForeignOrganizer(joinedAddress, onChainState.organizer, expectedOrganizer);
          return;
        }

        setLedger(onChainState);
        setLastUpdated(new Date());
        setApi(joined);
        setActiveAddress(joinedAddress);
        setPhase('idle');
        setMessage(undefined);
      } catch (err) {
        if (cancelled) return;
        // A persisted event from a DIFFERENT contract build can never be called
        // by this client — that is a permanent incompatibility, not a transient
        // indexer hiccup, so the record is marked unusable.
        if (isStaleContractBuildError(err)) {
          console.warn('[stale-build] persisted event came from a different contract build', err);
          markEventStaleBuild(err, record.address);
          return;
        }
        setPhase('error');
        const raw = err instanceof Error ? err.message : String(err);
        setMessage(
          `Could not restore event ${record.address.slice(0, 12)}… — ${raw}. If this looks wrong, click ` +
            `"Deploy a new wallet-backed event" to register a fresh event for this wallet.`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, api, getBundle]);

  /**
   * Binds to the CURRENT active event, and refuses to bind to anything that is
   * not a verified wallet-backed event. Returning the cached `api`
   * unconditionally is what caused the "still rejected as organizer" reports
   * after a new deploy: the address had been switched to the fresh event but the
   * stale ZKEventAccessAPI bound to the old event was still returned, so the
   * organizer comparison ran against the WRONG contract.
   *
   * The store is the single source of truth for the address, so Issue credential
   * and Verify access can never act on a different event than the one that was
   * verified. A gate failure is a state, not a crash: it is reported as
   * "needs an event" with the deploy action offered, not as a failed action.
   */
  const join = async (): Promise<ZKEventAccessAPI> => {
    const record = readActiveEventRecord();
    const gate = requireVerifiedActiveEvent(record);
    if (!gate.ok) {
      setPhase('needs-event');
      setMessage(gate.message);
      throw new NeedsActiveEventError(gate.message);
    }
    const contractAddress = activeAddress && activeAddress === gate.address ? activeAddress : gate.address;
    if (api && String(api.contractAddress) === contractAddress) return api;
    setPhase('joining');
    setMessage('Joining the verified event…');
    const bundle = getBundle();
    if (!bundle) throw new Error('Wallet is not connected.');
    const joined = await ZKEventAccessAPI.join(bundle.providers, contractAddress);
    setApi(joined);
    setActiveAddress(String(joined.contractAddress));
    setMessage(undefined);
    setPhase('idle');
    return joined;
  };

  /**
   * Root-cause handling for an event deployed from a DIFFERENT contract build.
   *
   * Such an event is permanently uncallable by this client: the instance
   * registered the verifier keys of the build that created it, and midnight-js
   * contracts refuses the join ("... are undefined or have mismatched verifier
   * keys ..."). Retrying, re-joining or re-proving can never fix it — only a new
   * deployment from the CURRENT artifacts can. The record is marked unusable
   * (address and reason kept), never deleted, and NO redeployment is started:
   * recovery is always an explicit user action.
   */
  const markEventStaleBuild = (err: unknown, address: string): void => {
    const circuits = staleContractBuildCircuits(err);
    console.warn(
      '[stale-build] marking event unusable; it was deployed from a different contract build',
      address,
      circuits,
    );
    const explanation = staleContractBuildMessage(address, circuits);
    invalidateActiveEvent('stale-build', explanation);
    setActiveAddress(undefined);
    setApi(undefined);
    setLedger(undefined);
    setPhase('error');
    setMessage(explanation);
  };

  /**
   * The event's on-chain organizer is not the connected 1AM wallet, so this
   * wallet can never increment on it. The record is marked unusable with the
   * exact mismatch, nothing is issued, and NO other event is deployed
   * automatically.
   */
  const markEventForeignOrganizer = (address: string, onChain: string, expected: string): void => {
    console.warn('[organizer-mismatch] event is owned by another organizer', address, onChain, expected);
    const explanation = organizerMismatchMessage(address, onChain, expected);
    invalidateActiveEvent('foreign-organizer', explanation);
    setActiveAddress(undefined);
    setApi(undefined);
    setLedger(undefined);
    setPhase('error');
    setMessage(explanation);
  };

  const runCircuit = async (name: 'increment' | 'read') => {
    const inFlightRef = name === 'increment' ? issueInFlightRef : readInFlightRef;
    if (inFlightRef.current) return; // same action already in flight — ignore the duplicate click
    // Only "Issue credential" submits. It must never start while the wallet still
    // holds an unconfirmed transaction, and this guard is deliberately in the
    // handler as well as on the button's `disabled`: it is the invariant that
    // actually prevents a second submission. Nothing is submitted while waiting.
    if (name === 'increment' && walletTxPending) {
      setPhase('error');
      setMessage(transactionPendingMessage());
      return;
    }
    inFlightRef.current = true;
    if (name === 'increment') setIssuePending(true);
    else setReadPending(true);
    try {
      const bundle = getBundle();
      const eventAccessApi = await join();
      setPhase('proving');
      setMessage(
        name === 'increment'
          ? `Generating ZK proof locally (${name}) — this runs in your browser…`
          : 'Reading the public ledger from the indexer — no proof and no transaction.',
      );
      if (name === 'increment') {
        // Mandatory pre-flight organizer check: read the event's registered
        // organizer commitment and compare it against the connected wallet's
        // derived identity, using the same canonical formula as the contract.
        // A transaction whose organizer assert is guaranteed to fail is never
        // submitted; a check that cannot be completed is treated as a failure,
        // never skipped.
        const activeEventAddress = String(eventAccessApi.contractAddress);
        const [expectedOrganizer, onChainState] = await Promise.all([
          ZKEventAccessAPI.currentOrganizerCommitment(bundle!.providers),
          eventAccessApi.readLatest(),
        ]);
        if (expectedOrganizer.toLowerCase() !== onChainState.organizer.toLowerCase()) {
          markEventForeignOrganizer(activeEventAddress, onChainState.organizer, expectedOrganizer);
          return;
        }
        await eventAccessApi.increment();
        // Once a transaction has been accepted by the wallet, re-read its queue:
        // the submission is not on-chain yet, and the UI must reflect that.
        void refreshWalletTxState();
      } else {
        // VERIFY ACCESS SUBMITS NOTHING.
        //
        // The contract's `read` circuit is `read(): Uint<64> { return counter; }`
        // — no witness, no state change, returning a value that is ALREADY
        // public ledger state. Calling it through `callTx.read()` therefore costs
        // a full local ZK proof plus a wallet transaction to obtain a number the
        // indexer will hand over for free, and it spends the wallet's single
        // pending-transaction slot to do it.
        //
        // So this action reads the public count directly. `readLatest()` below is
        // a plain query against the public data provider: no proof, no
        // submission, and therefore nothing to sequence and nothing that can be
        // rejected as "already pending".
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
        if (err instanceof OrganizerVerificationError || err instanceof OrganizerUnverifiedError) {
          setPhase('error');
          setMessage(err.message);
          return;
        }
        // The action was never started: there is no verified active event to act
        // on. That is a state to move on from, not a malfunction, so it keeps
        // the message the gate produced instead of being re-wrapped as one.
        if (err instanceof NeedsActiveEventError) {
          setPhase('needs-event');
          return;
        }
        // A stale-build event fails here too (join() throws ContractTypeError).
        // That is not an authorization problem and not something a retry can fix.
        if (isStaleContractBuildError(err)) {
          console.warn('[stale-build] active event came from a different contract build', err);
          markEventStaleBuild(err, readActiveEventRecord()?.address ?? 'the saved event');
          return;
        }
        // This browser lost the organizer key: it is unrecoverable, and it is
        // never replaced with a made-up one.
        if (err instanceof OrganizerIdentityUnavailableError) {
          console.warn('[organizer-identity] no organizer key for the active event', err);
          setApi(undefined);
          setActiveAddress(undefined);
          setPhase('error');
          setMessage(err.message);
          return;
        }
        setPhase('error');
        const raw = err instanceof Error ? err.message : String(err);
        setMessage(
          /organizer authorization failed/i.test(raw)
            ? raw
            : /assert/i.test(raw)
              ? `Access issuance was rejected on-chain on event ${activeAddress ?? '(configured event)'}: the connected 1AM wallet is not the registered organizer of this event, and only the organizer can issue access. ${FOREIGN_ORGANIZER_HEADLINE} ({${raw}})`
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
   * entered or stored anywhere).
   *
   * The event becomes ACTIVE only after its on-chain `organizer` commitment has
   * been read back and matched against the connected wallet. Before that it is
   * remembered as `unverified` — never usable — and on a mismatch the exact two
   * values are shown, nothing is activated, and no further event is deployed.
   */
  const deployNewEvent = async (note?: string) => {
    if (deployInFlightRef.current) return; // duplicate deploy click — no-op
    // A deploy submits a transaction and costs a real on-chain fee, so it must
    // never start while the wallet still holds an unconfirmed one. Same
    // deliberate belt-and-braces guard as "Issue credential": nothing is
    // submitted, and no event is deployed, while the wallet is busy.
    if (walletTxPending) {
      setPhase('error');
      setMessage(transactionPendingMessage());
      return;
    }
    deployInFlightRef.current = true;
    setDeployPending(true);
    try {
      const bundle = getBundle();
      if (!bundle) throw new Error('Wallet is not connected.');
      setPhase('proving');
      setMessage(
        (note ? `${note} ` : '') +
          'Approve the deployment in the connected 1AM wallet. Waiting for on-chain inclusion, then verifying ' +
          'this wallet is the registered organizer…',
      );
      const { api: deployed, organizerCommitment: expectedOrganizer } = await ZKEventAccessAPI.deployNew(
        bundle.providers,
        undefined,
        (address) => {
          // The deployment is finalized on-chain, so the address is a real fact —
          // but it is NOT verified yet and must not be treated as active.
          recordUnverifiedDeployment(address);
          setActiveAddress(undefined);
          setApi(undefined);
          setLedger(undefined);
        },
      );
      const newAddress = String(deployed.contractAddress);

      // Independent confirmation, straight from the indexer, before anything is
      // written as `verified`. The expectation is the very commitment the
      // constructor was run with for THIS deployment — deliberately not a second
      // resolution of the wallet identity, which could differ because the 1AM
      // wallet's signData is non-deterministic and would report a mismatch for a
      // correct deployment.
      const onChainState = await deployed.readLatest();
      if (expectedOrganizer.toLowerCase() !== onChainState.organizer.toLowerCase()) {
        throw new OrganizerVerificationError(newAddress, onChainState.organizer, expectedOrganizer);
      }

      recordVerifiedActiveEvent(newAddress, onChainState.organizer);

      // CONFIRM the activation instead of assuming it. The address Issue and
      // Verify will use is read back out of the active-event store, so the
      // success path can never report an event the actions would refuse. This is
      // the step that was missing: the record was written and the app declared
      // success, so a browser that refused the write silently fell back to
      // "No event contract address configured" for a wallet that owns a live
      // on-chain event.
      const activatedAddress = readVerifiedActiveEventAddress();
      if (activatedAddress !== newAddress) {
        throw new ActiveEventActivationError(newAddress);
      }
      const durable = isActiveEventDurable();
      setApi(deployed);
      setActiveAddress(activatedAddress);
      setLedger(onChainState);
      setLastUpdated(new Date());
      setPhase('done');
      setMessage(
        (note ? `${note} ` : '') +
          `New event deployed and verified on-chain as owned by this 1AM wallet (organizer commitment read from ` +
          `the indexer and matched: ${onChainState.organizer}). Address: ${activatedAddress}. It is now the active ` +
          `event, so "Issue credential" and "Verify access" both use it.` +
          (durable ? '' : ` ${activeEventNotPersistedMessage(activatedAddress)}`),
      );
    } catch (err) {
      const record = readActiveEventRecord();
      // A verified event that was already active before this attempt survives a
      // failed deploy untouched; anything else (no event, unverified, or
      // invalidated) leaves nothing to act on.
      const stillActive = record?.status === 'verified';
      if (!stillActive) {
        setApi(undefined);
        setActiveAddress(undefined);
        setLedger(undefined);
      }
        // The wallet declined this request because another transaction is still
        // pending. Not a contract failure and not an authorization problem, and
        // retrying into the same wall changes nothing — so it is explained
        // rather than printed as a raw "error: …".
        if (isTransactionPendingError(err)) {
          console.warn('[tx-pending] the wallet refused a second concurrent transaction', err);
          setPhase('error');
          setMessage(transactionPendingMessage());
          return;
        }
        setPhase('error');
        const raw = err instanceof Error ? err.message : String(err);
      const noFunds = /insufficient|not enough|funds|balance|dust/i.test(raw);
      const rejected = /rejected|denied|user declined|abort|cancel/i.test(raw);
      setMessage(
        (note ? `${note} ` : '') +
          (err instanceof OrganizerVerificationError ||
          err instanceof OrganizerUnverifiedError ||
          err instanceof OrganizerKeyPersistenceError ||
          err instanceof OrganizerIdentityUnavailableError ||
          err instanceof ActiveEventActivationError
            ? raw
            : rejected
              ? `Deployment was not approved in the 1AM wallet (${raw}). Click "Deploy a new wallet-backed event" to try again when ready.`
              : noFunds
                ? `Deployment failed: ${raw}. The 1AM wallet needs preprod funds (T$ and DUST) to finalize the deploy transaction. Fund it via the Midnight faucet, then press "Deploy a new wallet-backed event".`
                : `Deployment failed: ${raw}`),
      );
    } finally {
      deployInFlightRef.current = false;
      setDeployPending(false);
      // The deploy transaction is submitted but not on-chain yet, so the wallet
      // is still busy. Re-read its queue so Issue/Deploy stay disabled until it
      // confirms or is discarded, instead of being re-enabled immediately.
      void refreshWalletTxState();
    }
  };

  // Which actions may submit a wallet transaction RIGHT NOW.
  //
  // Issue and Deploy both submit, so they are mutually exclusive AND both are
  // blocked while the wallet already holds an unconfirmed transaction. That
  // second condition is the one that matters: the wallet keeps a transaction
  // pending after `submitTransaction` has already resolved, so gating on this
  // app's own promises alone re-enables the buttons during exactly the window in
  // which the wallet refuses a new one.
  //
  // Verify access is deliberately NOT in this lock: it reads public ledger state
  // and submits nothing, so it stays usable while a transaction is in flight.
  const walletTxPending = walletTxState === 'pending';
  const txBusy = issuePending || deployPending || walletTxPending;
  const busy = txBusy || readPending;

  // There is deliberately NO automatic deployment on connect. A deployment costs
  // a real on-chain fee and pops 1AM approval dialogs, so it is only ever started
  // by an explicit click on "Deploy a new wallet-backed event".

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

  const record = readActiveEventRecord();
  const hasVerifiedEvent = record?.status === 'verified';
  const isWorking = busy || phase === 'joining' || phase === 'proving';
  // A pending wallet transaction is a state to wait out, not a failure, so it
  // gets its own working tone and title instead of being reported as an error.
  const showWalletPending = walletTxPending && phase !== 'error';
  const statusTone =
    phase === 'error' ? 'error' : phase === 'done' ? 'success' : phase === 'needs-event' ? 'neutral' : phase === 'idle' ? 'neutral' : 'working';
  const statusTitle =
    phase === 'error'
      ? 'We could not complete that action'
      : showWalletPending
        ? 'Waiting for the wallet to confirm a transaction'
        : phase === 'done'
          ? 'Action complete'
          : phase === 'needs-event'
            ? 'This action needs a wallet-backed event'
            : phase === 'joining' || phase === 'proving'
              ? 'Working securely'
              : !connected
                ? 'Connect your wallet to continue'
                : hasVerifiedEvent
                  ? 'Ready for the next action'
                  : 'No verified event yet';
  const statusBody =
    message ??
    (phase === 'error'
      ? 'Review the message above, then try again or open a fresh event.'
      : showWalletPending
        ? 'The 1AM wallet has a transaction that is not on-chain yet, and it accepts only one at a time. Nothing further ' +
          'will be submitted until it is confirmed or expires. "Verify access" still works — it only reads the public count.'
        : phase === 'done'
          ? 'The public ledger is refreshed below.'
          : phase === 'joining' || phase === 'proving'
            ? 'Keep this tab open while the wallet and network complete the request.'
            : !connected
              ? 'Your organizer identity stays in the wallet; no secret key is pasted into this app.'
              : hasVerifiedEvent
                ? 'Issue a credential for an authorized organizer or verify the current public count.'
                : connected
                  ? 'No verified event is configured. Click "Deploy a new wallet-backed event" to make this wallet the on-chain organizer.'
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
        <span className={`status-chip ${ledger ? 'status-chip-success' : hasVerifiedEvent ? 'status-chip-warning' : ''}`}>
          <span className="status-dot" aria-hidden="true" />
          {ledger ? 'Synced' : hasVerifiedEvent ? 'Connecting' : record ? 'Unverified' : 'No event'}
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

        {hasVerifiedEvent && activeAddress ? (
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
            <span className="status-chip status-chip-success"><span className="status-dot" aria-hidden="true" /> Verified</span>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true"><GlobeIcon /></div>
            <div className="empty-state-copy">
              <h3 className="empty-state-title">No verified event</h3>
              <p>
                {record?.status === 'unverified'
                  ? 'A new event is on-chain but its organizer is not verified yet, so it cannot be used.'
                  : record
                    ? 'The event saved in this browser is not usable by this wallet.'
                    : 'No wallet-backed event is configured in this browser yet.'}{' '}
                Click “Deploy a new wallet-backed event” to make this 1AM wallet the on-chain organizer.
              </p>
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
              disabled={!connected || txBusy}
              onClick={() => runCircuit('increment')}
              title={
                walletTxPending
                  ? 'Waiting for the 1AM wallet to confirm its pending transaction'
                  : 'Organizer-only: issues a credential on the active verified event'
              }
            >
              <span className="action-card-icon" aria-hidden="true"><PlusIcon /></span>
              <span className="action-card-copy">
                <span className="action-card-title">Issue credential</span>
                <span className="action-card-description">
                  {walletTxPending ? 'Waiting for the wallet…' : 'Organizer-only · adds one access'}
                </span>
              </span>
              <span className="action-card-arrow" aria-hidden="true"><ChevronRightIcon /></span>
            </button>
            <button
              className="action-card action-card-secondary"
              type="button"
              disabled={!connected || readPending}
              onClick={() => runCircuit('read')}
              title="Read the public ledger of the active verified event (a public indexer query — no proof, no transaction)"
            >
              <span className="action-card-icon" aria-hidden="true"><ScanIcon /></span>
              <span className="action-card-copy">
                <span className="action-card-title">Verify access</span>
                <span className="action-card-description">Read the public ledger count · no transaction</span>
              </span>
              <span className="action-card-arrow" aria-hidden="true"><ChevronRightIcon /></span>
            </button>
          </div>
          <button
            className="deploy-button"
            type="button"
            disabled={!connected || txBusy}
            onClick={() => deployNewEvent()}
            title={
              walletTxPending
                ? 'Waiting for the 1AM wallet to confirm its pending transaction'
                : 'Organizer-only: deploy a new event whose organizer identity is held by this wallet'
            }
          >
            <SparklesIcon />
            <span>
              {deployPending
                ? 'Deploying and verifying event…'
                : walletTxPending
                  ? 'Waiting for the wallet to confirm…'
                  : 'Deploy a new wallet-backed event'}
            </span>
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
