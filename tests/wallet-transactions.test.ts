/**
 * Regression coverage for the WALLET's pending-transaction gate.
 *
 * The defect these exist for: `ConnectedAPI.submitTransaction()` resolves when
 * the wallet ACCEPTS a submission as a relayer, not when the transaction reaches
 * a block. The app used to treat its own settled promise as "the wallet is free",
 * re-enabled every action immediately, and the next click was rejected with
 *
 *   Unexpected error submitting scoped transaction '<unnamed>':
 *   Error: A transaction is already pending. Wait for it to confirm or expire…
 *
 * So the invariant under test is NOT "the app is awaiting a promise" but "the
 * wallet has no unconfirmed transaction". These cases drive the real observer
 * against a fake wallet that models the four `TxStatus` values, and they assert
 * that the observer never submits, never retries, and stops as soon as the
 * wallet is genuinely free again.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isPendingTxStatus,
  readWalletTxState,
  watchWalletTxState,
  TX_HISTORY_PAGE_SIZE,
  type TxHistoryReader,
  type WalletTxState,
} from '../src/midnight/wallet-transactions';

const TX_A = 'a'.repeat(64);
const TX_B = 'b'.repeat(64);

type Status = 'pending' | 'confirmed' | 'finalized' | 'discarded';

/** A wallet whose queue the test controls, exactly like the real TxStatus union. */
const walletWith = (initial: Array<{ txHash: string; status: Status }>): TxHistoryReader & {
  readonly calls: () => number;
  readonly setEntries: (next: Array<{ txHash: string; status: Status }>) => void;
} => {
  let entries = initial;
  let calls = 0;
  return {
    getTxHistory: vi.fn(async (pageNumber: number, pageSize: number) => {
      calls += 1;
      return entries.slice(pageNumber, pageNumber + pageSize).map((e) => ({
        txHash: e.txHash,
        txStatus: e.status === 'pending' ? { status: 'pending' as const } : { status: e.status, executionStatus: {} },
      }));
    }),
    calls: () => calls,
    setEntries: (next) => {
      entries = next;
    },
  };
};

describe('isPendingTxStatus', () => {
  it('treats only `pending` as blocking, so every terminal status frees the wallet', () => {
    expect(isPendingTxStatus({ status: 'pending' })).toBe(true);
    // confirmed/finalized are in a block; discarded is TTL expiry or a validity
    // failure. All three mean a fresh transaction is allowed, which is what stops
    // a failed or expired transaction from blocking the app forever.
    expect(isPendingTxStatus({ status: 'confirmed', executionStatus: {} })).toBe(false);
    expect(isPendingTxStatus({ status: 'finalized', executionStatus: {} })).toBe(false);
    expect(isPendingTxStatus({ status: 'discarded' })).toBe(false);
    expect(isPendingTxStatus(undefined)).toBe(false);
  });
});

describe('readWalletTxState', () => {
  it('reports pending when the wallet holds an unconfirmed transaction', async () => {
    expect(await readWalletTxState(walletWith([{ txHash: TX_A, status: 'pending' }]))).toBe('pending');
  });

  it('reports idle when the newest transaction is on-chain or was discarded', async () => {
    expect(await readWalletTxState(walletWith([{ txHash: TX_A, status: 'finalized' }]))).toBe('idle');
    // An expired/failed transaction must NOT read as pending, or the app would
    // stay disabled with no way to recover.
    expect(await readWalletTxState(walletWith([{ txHash: TX_A, status: 'discarded' }]))).toBe('idle');
  });

  it('prefers pending over a confirmed sibling, so one stuck tx is still seen', async () => {
    const wallet = walletWith([
      { txHash: TX_B, status: 'finalized' },
      { txHash: TX_A, status: 'pending' },
    ]);
    expect(await readWalletTxState(wallet)).toBe('pending');
  });

  it('reports unknown — never idle — when the history cannot be read', async () => {
    const broken: TxHistoryReader = {
      getTxHistory: vi.fn(async () => {
        throw new Error('wallet channel closed');
      }),
    };
    // Guessing "free" is exactly what produces a duplicate submission, so an
    // unreadable history is explicitly NOT the same answer as an empty queue.
    expect(await readWalletTxState(broken)).toBe('unknown');

    const garbage: TxHistoryReader = { getTxHistory: vi.fn(async () => undefined as never) };
    expect(await readWalletTxState(garbage)).toBe('unknown');
  });

  it('asks only for a recent page, and never submits anything', async () => {
    const wallet = walletWith([{ txHash: TX_A, status: 'pending' }]);
    const submitSpy = vi.fn();
    await readWalletTxState({ ...wallet, submitTransaction: submitSpy } as never);
    expect(wallet.getTxHistory).toHaveBeenCalledWith(0, TX_HISTORY_PAGE_SIZE);
    // The observer is read-only by construction: it has no submit path at all.
    expect(submitSpy).not.toHaveBeenCalled();
  });
});

describe('watchWalletTxState', () => {
  it('blocks while pending, then clears the moment the transaction confirms', async () => {
    const wallet = walletWith([{ txHash: TX_A, status: 'pending' }]);
    const seen: WalletTxState[] = [];
    const watcher = watchWalletTxState(wallet, (s) => seen.push(s), 10_000);

    await watcher.refresh();
    expect(seen).toEqual(['pending']);

    // Confirmed: in a block, so the wallet is free and a new action is allowed.
    wallet.setEntries([{ txHash: TX_A, status: 'confirmed' }]);
    await watcher.refresh();
    expect(seen).toEqual(['pending', 'idle']);

    watcher.stop();
  });

  it('clears the pending state when the transaction expires or fails', async () => {
    const wallet = walletWith([{ txHash: TX_A, status: 'pending' }]);
    const seen: WalletTxState[] = [];
    const watcher = watchWalletTxState(wallet, (s) => seen.push(s), 10_000);

    await watcher.refresh();
    expect(seen).toEqual(['pending']);

    // Discarded = TTL expiry or a validity failure: a fresh transaction is allowed.
    wallet.setEntries([{ txHash: TX_A, status: 'discarded' }]);
    await watcher.refresh();
    expect(seen).toEqual(['pending', 'idle']);

    watcher.stop();
  });

  it('never reports the same state twice, so the UI cannot thrash', async () => {
    const wallet = walletWith([{ txHash: TX_A, status: 'pending' }]);
    const onChange = vi.fn();
    const watcher = watchWalletTxState(wallet, onChange, 10_000);

    await watcher.refresh();
    await watcher.refresh();
    await watcher.refresh();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('pending');

    watcher.stop();
  });

  it('polls only while something is pending, and stops once the wallet is free', async () => {
    vi.useFakeTimers();
    try {
      const wallet = walletWith([{ txHash: TX_A, status: 'pending' }]);
      const watcher = watchWalletTxState(wallet, () => {}, 1000);
      await vi.advanceTimersByTimeAsync(0);
      const whilePending = wallet.calls();
      expect(whilePending).toBeGreaterThan(0);

      // Still pending: it keeps waiting, because only the wallet can clear this.
      await vi.advanceTimersByTimeAsync(3000);
      expect(wallet.calls()).toBeGreaterThan(whilePending);

      // Confirmed: the wait ends and polling stops. An idle app must not keep
      // calling the wallet in the background.
      wallet.setEntries([{ txHash: TX_A, status: 'finalized' }]);
      await vi.advanceTimersByTimeAsync(1000);
      const afterClear = wallet.calls();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(wallet.calls()).toBe(afterClear);

      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes quiet after stop(), so a disconnected wallet is not polled', async () => {
    const wallet = walletWith([{ txHash: TX_A, status: 'pending' }]);
    const onChange = vi.fn();
    const watcher = watchWalletTxState(wallet, onChange, 10_000);
    await watcher.refresh();
    expect(onChange).toHaveBeenCalledWith('pending');

    watcher.stop();
    // Even an explicit refresh after stop must not reach the UI, and no late
    // timer callback may fire.
    wallet.setEntries([{ txHash: TX_A, status: 'finalized' }]);
    await watcher.refresh();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('never clears a known-pending transaction because a read failed', async () => {
    let failing = false;
    const reader: TxHistoryReader = {
      getTxHistory: vi.fn(async () => {
        if (failing) throw new Error('wallet channel closed');
        return [{ txHash: TX_A, txStatus: { status: 'pending' as const } }];
      }),
    };
    const seen: WalletTxState[] = [];
    const watcher = watchWalletTxState(reader, (s) => seen.push(s), 10_000);

    await watcher.refresh();
    expect(seen).toEqual(['pending']);

    // A transient wallet failure must NOT be reported as "free": that is exactly
    // how a second submission gets attempted against a busy wallet. The pending
    // answer is retained until a terminal status is positively observed.
    failing = true;
    expect(await watcher.refresh()).toBe('pending');
    expect(seen).toEqual(['pending']);

    // A positive terminal status still clears it, so a stuck wallet can never
    // leave the app disabled forever.
    failing = false;
    expect(await watcher.refresh()).toBe('pending');
    reader.getTxHistory = vi.fn(async () => [
      { txHash: TX_A, txStatus: { status: 'finalized' as const, executionStatus: {} } },
    ]);
    expect(await watcher.refresh()).toBe('idle');
    expect(seen).toEqual(['pending', 'idle']);

    watcher.stop();
  });

  it('reports unknown when the very first read fails, instead of claiming idle', async () => {
    const broken: TxHistoryReader = {
      getTxHistory: vi.fn(async () => {
        throw new Error('wallet channel closed');
      }),
    };
    const seen: WalletTxState[] = [];
    const watcher = watchWalletTxState(broken, (s) => seen.push(s), 10_000);

    // Never known to be pending, so there is nothing to wait for. The app stays
    // usable rather than being bricked by an unsupported history endpoint.
    expect(await watcher.refresh()).toBe('unknown');
    // 'unknown' was already the starting value, so the UI is not re-rendered.
    expect(seen).toEqual([]);

    watcher.stop();
  });
});
