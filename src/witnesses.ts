import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../managed/counter/contract/index.js';

/**
 * Private state held locally by each DApp user. It NEVER leaves the user's
 * machine — only zero-knowledge proofs about it are submitted on-chain.
 */
export type CounterPrivateState = {
  readonly organizerSecretKey: Uint8Array;
};

export const createCounterPrivateState = (
  organizerSecretKey: Uint8Array,
): CounterPrivateState => ({
  organizerSecretKey,
});

/**
 * TypeScript implementation of the `organizerSecret()` witness declared in
 * counter.compact. Runs off-chain, inside the user's DApp: the Compact
 * compiler holds only the declaration.
 */
export const witnesses = {
  organizerSecret: ({
    privateState,
  }: WitnessContext<Ledger, CounterPrivateState>): [
    CounterPrivateState,
    Uint8Array,
  ] => [privateState, privateState.organizerSecretKey],
};
