import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../managed/zk-event-access/contract/index.js';

/**
 * Private state held locally by each DApp user. It NEVER leaves the user's
 * machine — only zero-knowledge proofs about it are submitted on-chain.
 */
export type ZKEventAccessPrivateState = {
  readonly organizerSecretKey: Uint8Array;
};

export const createZKEventAccessPrivateState = (
  organizerSecretKey: Uint8Array,
): ZKEventAccessPrivateState => ({
  organizerSecretKey,
});

/**
 * TypeScript implementation of the `organizerSecret()` witness declared in
 * zk-event-access.compact. Runs off-chain, inside the user's DApp: the Compact
 * compiler holds only the declaration.
 */
export const witnesses = {
  organizerSecret: ({
    privateState,
  }: WitnessContext<Ledger, ZKEventAccessPrivateState>): [
    ZKEventAccessPrivateState,
    Uint8Array,
  ] => [privateState, privateState.organizerSecretKey],
};
