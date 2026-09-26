/**
 * The WALLET's pending-transaction state, which is the only truthful answer to
 * "may this app submit another transaction right now?".
 *
 * ── Why the app's own request state is not the answer ───────────────────────
 *
 * `ConnectedAPI.submitTransaction(tx): Promise<void>` resolves when the wallet
 * has ACCEPTED the submission as a relayer. It does not resolve when the
 * transaction is included in a block — the SDK returns no transaction id and
 * exposes no completion callback. So an app that clears its "busy" flag when its
 * own promise settles believes the wallet is free while the transaction is still
 * `pending` inside it, and the very next action is rejected with
 *
 *   Unexpected error submitting scoped transaction '<unnamed>':
 *   Error: A transaction is already pending. Wait for it to confirm or expire…
 *
 * Those are two different windows: "my request is in flight" and "the wallet has
 * an unconfirmed transaction". Only the second one gates a submission. The wallet
 * exposes the second through `getTxHistory()`, whose entries carry a
 * {@link TxStatus} of `pending` | `confirmed` | `finalized` | `discarded`.
 *
 * ── Why this module never submits anything ─────────────────────────────────
 *
 * It is a read-only observer. It must never "help along" a stuck transaction by
 * retrying, replacing or superseding it: a second submission is precisely what
 * the wallet refuses, and an automatic retry would turn a transient wait into an
 * unrecoverable account of rejections. It only ever *reports*, and the UI decides
 * what to disable.
 */
import type { ConnectedAPI, TxStatus } from '@midnight-ntwrk/dapp-connector-api';

/**
 * How the app is allowed to treat the wallet's transaction queue.
 *
 * `unknown` is deliberately distinct from `idle`: when the history cannot be read
 * the app has NOT learned that the wallet is free.
 */
export type WalletTxState =
  /** No transaction in flight — a new one may be submitted. */
  | 'idle'
  /** A submitted transaction has not been confirmed or discarded — submit nothing. */
  | 'pending'
  /** The wallet's history could not be read, so the state is not known. */
  | 'unknown';

/** Recent entries are enough to see a transaction this app just submitted. */
export const TX_HISTORY_PAGE_SIZE = 25;

/** Only the part of the wallet API this module needs, so it is trivially fakeable. */
export type TxHistoryReader = Pick<ConnectedAPI, 'getTxHistory'>;

/**
 * True only for a transaction the wallet has sent but that is not yet in a
 * block. `confirmed` and `finalized` are in a block, and `discarded` means the
 * wallet is free again (TTL expiry or a validity failure), so all three mean
 * "a fresh transaction is allowed".
 */
export const isPendingTxStatus = (status: TxStatus | undefined): boolean => status?.status === 'pending';

/**
 * Reads the wallet's transaction queue once. Never throws and never submits.
 *
 * On an unreadable history it reports `unknown` rather than `idle`, because
 * guessing "free" is what produces a duplicate submission. Callers treat
 * `unknown` as permissive ONLY because the wallet itself is the final authority
 * and rejects a second transaction regardless of what this app believes — see
 * {@link watchWalletTxState}.
 */
export const readWalletTxState = async (api: TxHistoryReader): Promise<WalletTxState> => {
  try {
    const history = await api.getTxHistory(0, TX_HISTORY_PAGE_SIZE);
    if (!Array.isArray(history)) return 'unknown';
    return history.some((entry) => isPendingTxStatus(entry?.txStatus)) ? 'pending' : 'idle';
  } catch {
    return 'unknown';
  }
};

export interface WalletTxWatcher {
  /** Re-reads the wallet now. Awaitable, so callers can sync after submitting. */
  refresh: () => Promise<WalletTxState>;
  /** Stops polling. Safe to call more than once. */
  stop: () => void;
}

/**
 * Observes the wallet's pending state, polling ONLY while something is pending.
 *
 * Three properties matter:
 *
 *   - it never polls while the wallet is idle, so an idle app makes no
 *     background calls to the wallet;
 *   - it keeps polling until the transaction reaches `confirmed`/`finalized`
 *     (pending state cleared) or `discarded` (TTL expiry or failure, so a fresh
 *     transaction is allowed). Both end the wait, so the UI can never be left
 *     permanently disabled by a transaction that will never confirm;
 *   - a failed read NEVER clears a known-pending transaction. Only a positively
 *     observed terminal status frees the app, so a transient wallet error can
 *     not re-enable the buttons while a transaction is still unconfirmed.
 *
 * `unknown` is not polled: there is nothing to wait for, and the next
 * {@link WalletTxWatcher.refresh} (triggered after the app's own submissions)
 * re-reads it.
 */
export const watchWalletTxState = (
  api: TxHistoryReader,
  onChange: (state: WalletTxState) => void,
  intervalMs = 2000,
): WalletTxWatcher => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: WalletTxState = 'unknown';

  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, intervalMs);
  };

  const refresh = async (): Promise<WalletTxState> => {
    // `readWalletTxState` is total: it answers `unknown` rather than throwing,
    // when the history cannot be read.
    const observed = await readWalletTxState(api);
    // `unknown` means "could not be determined". If the wallet has already told
    // us it holds an unconfirmed transaction, that answer is retained until a
    // terminal status is positively observed. Guessing "free" here is the one
    // thing that must not happen, because it invites a duplicate submission
    // against a busy wallet — the exact failure this whole module prevents.
    const next = observed === 'unknown' && state === 'pending' ? 'pending' : observed;
    if (stopped) return next;
    if (next !== state) {
      state = next;
      onChange(next);
    }
    // Keep waiting only while there is something that can still change.
    if (state === 'pending') schedule();
    return state;
  };

  void refresh();

  return {
    refresh,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
};
