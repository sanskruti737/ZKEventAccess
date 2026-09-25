import { describe, it, expect, beforeEach } from 'vitest';
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type CircuitContext,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, type Ledger } from '../managed/counter/contract/index.js';
import {
  witnesses,
  createCounterPrivateState,
  type CounterPrivateState,
} from '../src/witnesses.js';

// Deterministic test keys (32 bytes each, as required by Bytes<32>).
const ORGANIZER_SECRET = new Uint8Array(32).fill(7);
const NEW_ORGANIZER_SECRET = new Uint8Array(32).fill(11);
const IMPOSTOR_SECRET = new Uint8Array(32).fill(9);

type Ctx = CircuitContext<CounterPrivateState>;

/** Deploy the contract in a local simulator and return it with a fresh circuit context. */
function makeContract(secret: Uint8Array): { contract: Contract<CounterPrivateState>; ctx: Ctx } {
  const contract = new Contract<CounterPrivateState>(witnesses);
  const address = sampleContractAddress();
  const init = contract.initialState(
    createConstructorContext(createCounterPrivateState(secret), {
      bytes: new Uint8Array(32),
    }),
  );
  const ctx = createCircuitContext(
    address,
    init.currentZswapLocalState,
    init.currentContractState,
    init.currentPrivateState,
  );
  return { contract, ctx };
}

/** Read the public ledger as seen after the given context's execution. */
function readLedger(ctx: Ctx): Ledger {
  return ledger(ctx.currentQueryContext.state);
}

/** Recursively collect every Uint8Array embedded in an arbitrary value graph. */
function collectBytes(value: unknown, out: Uint8Array[] = []): Uint8Array[] {
  if (value instanceof Uint8Array) {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectBytes(v, out);
  } else if (value instanceof Map) {
    for (const [k, v] of value) {
      collectBytes(k, out);
      collectBytes(v, out);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectBytes(v, out);
  }
  return out;
}

/** True when `needle` appears anywhere inside `haystack` as a contiguous subsequence. */
function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe('ZKEventAccess counter', () => {
  let contract: Contract<CounterPrivateState>;
  let ctx: Ctx;

  beforeEach(() => {
    ({ contract, ctx } = makeContract(ORGANIZER_SECRET));
  });

  // ─── Circuit logic ─────────────────────────────────────────────────────────

  it('starts with a counter of zero', () => {
    const result = contract.impureCircuits.read(ctx);
    expect(result.result).toBe(0n);
  });

  it('rejects an empty organizer secret at deployment', () => {
    expect(() => makeContract(new Uint8Array(32))).toThrow(
      /organizer secret must not be empty/,
    );
  });

  it('lets the organizer increment the counter', () => {
    const r1 = contract.impureCircuits.increment(ctx);
    const r2 = contract.impureCircuits.read(r1.context);
    expect(r2.result).toBe(1n);
  });

  it('rejects increment by anyone who does not know the organizer secret', () => {
    const impostorCtx: Ctx = {
      ...ctx,
      currentPrivateState: createCounterPrivateState(IMPOSTOR_SECRET),
    };
    expect(() => contract.impureCircuits.increment(impostorCtx)).toThrow(
      /only the organizer can issue access/,
    );
  });

  it('rejects decrement and announcement by an impostor', () => {
    const impostorCtx: Ctx = {
      ...ctx,
      currentPrivateState: createCounterPrivateState(IMPOSTOR_SECRET),
    };
    expect(() => contract.impureCircuits.decrement(impostorCtx)).toThrow(
      /only the organizer can revoke access/,
    );
    expect(() => contract.impureCircuits.announce(impostorCtx, 'unauthorized')).toThrow(
      /only the organizer can announce/,
    );
  });

  it('rotates authority only for the current organizer', () => {
    const rotated = contract.impureCircuits.rotate(ctx, NEW_ORGANIZER_SECRET);
    const oldOrganizerCtx: Ctx = {
      ...rotated.context,
      currentPrivateState: createCounterPrivateState(ORGANIZER_SECRET),
    };
    const newOrganizerCtx: Ctx = {
      ...rotated.context,
      currentPrivateState: createCounterPrivateState(NEW_ORGANIZER_SECRET),
    };

    expect(() => contract.impureCircuits.increment(oldOrganizerCtx)).toThrow(
      /only the organizer can issue access/,
    );
    expect(contract.impureCircuits.increment(newOrganizerCtx).context.currentPrivateState).toEqual(
      createCounterPrivateState(NEW_ORGANIZER_SECRET),
    );
  });

  it('rejects empty, unchanged, and unauthorized rotations', () => {
    const impostorCtx: Ctx = {
      ...ctx,
      currentPrivateState: createCounterPrivateState(IMPOSTOR_SECRET),
    };
    expect(() => contract.impureCircuits.rotate(ctx, new Uint8Array(32))).toThrow(
      /new organizer secret must not be empty/,
    );
    expect(() => contract.impureCircuits.rotate(ctx, ORGANIZER_SECRET)).toThrow(
      /new organizer secret must differ/,
    );
    expect(() => contract.impureCircuits.rotate(impostorCtx, NEW_ORGANIZER_SECRET)).toThrow(
      /only the organizer can rotate authority/,
    );
  });

  it('rejects decrement below zero', () => {
    expect(() => contract.impureCircuits.decrement(ctx)).toThrow(/already zero/);
  });

  // ─── State transitions ─────────────────────────────────────────────────────

  it('tracks issue/revoke sequences correctly across chained calls', () => {
    const r1 = contract.impureCircuits.increment(ctx);
    const r2 = contract.impureCircuits.increment(r1.context);
    const r3 = contract.impureCircuits.increment(r2.context);
    const r4 = contract.impureCircuits.decrement(r3.context);
    expect(contract.impureCircuits.read(r4.context).result).toBe(2n);
  });

  it('persists counter transitions in the public ledger state', () => {
    const r1 = contract.impureCircuits.increment(ctx);
    expect(readLedger(r1.context).counter).toBe(1n);
    const r2 = contract.impureCircuits.decrement(r1.context);
    expect(readLedger(r2.context).counter).toBe(0n);
  });

  it('publishes an announcement only through explicit disclose()', () => {
    const message = 'Gate A opens at 18:00 — bring your proof';
    const r1 = contract.impureCircuits.announce(ctx, message);
    expect(readLedger(r1.context).announcement).toBe(message);
  });

  // ─── Privacy: private inputs are never exposed ──────────────────────────────

  it('stores only a commitment to the organizer key, never the key itself', () => {
    const r1 = contract.impureCircuits.increment(ctx);
    const stored = readLedger(r1.context).organizer;
    const deployment = readLedger(r1.context).contractAddress;

    expect(stored).toBeInstanceOf(Uint8Array);
    expect(stored.length).toBe(32);
    expect(deployment).toBeInstanceOf(Uint8Array);
    expect(deployment.length).toBe(32);
    // The raw secret must not be what is on-chain.
    expect(Array.from(stored)).not.toEqual(Array.from(ORGANIZER_SECRET));
    // The commitment is deterministic in the secret: same key → same
    // commitment; different key → different commitment.
    const twin = makeContract(ORGANIZER_SECRET);
    const other = makeContract(IMPOSTOR_SECRET);
    expect(Array.from(readLedger(twin.ctx).organizer)).toEqual(Array.from(stored));
    expect(Array.from(readLedger(other.ctx).organizer)).not.toEqual(Array.from(stored));
  });

  it('never leaks the private witness into any public artifact', () => {
    // Run every state-changing circuit to maximise public output surface.
    const r1 = contract.impureCircuits.increment(ctx);
    const r2 = contract.impureCircuits.decrement(r1.context);
    const r3 = contract.impureCircuits.announce(r2.context, 'hello public world');
    const r4 = contract.impureCircuits.rotate(r3.context, NEW_ORGANIZER_SECRET);
    const finalCtx = r4.context;

    // Public side: on-chain ledger state + public transcripts + tx effects.
    const publicArtifacts = [
      ...collectBytes(readLedger(finalCtx)),
      ...collectBytes(r1.proofData.output),
      ...collectBytes(r2.proofData.output),
      ...collectBytes(r3.proofData.output),
      ...collectBytes(r4.proofData.output),
      ...collectBytes(r1.proofData.publicTranscript),
      ...collectBytes(r2.proofData.publicTranscript),
      ...collectBytes(r3.proofData.publicTranscript),
      ...collectBytes(r4.proofData.publicTranscript),
      ...collectBytes(finalCtx.currentQueryContext.effects),
    ];
    for (const artifact of publicArtifacts) {
      expect(containsSubsequence(artifact, ORGANIZER_SECRET)).toBe(false);
      expect(containsSubsequence(artifact, NEW_ORGANIZER_SECRET)).toBe(false);
    }

    // Private side: the secret really was fed INTO the proof as witness data
    // (private proof input / private transcript), which never goes on-chain.
    const privateSides = [
      ...collectBytes(r1.proofData.input),
      ...collectBytes(r1.proofData.privateTranscriptOutputs ?? []),
      ...collectBytes(r4.proofData.input),
    ];
    const secretIsAWitnessInput = privateSides.some((artifact) =>
      containsSubsequence(artifact, ORGANIZER_SECRET),
    );
    const newSecretIsCircuitInput = collectBytes(r4.proofData.input).some((artifact) =>
      containsSubsequence(artifact, NEW_ORGANIZER_SECRET),
    );
    expect(secretIsAWitnessInput).toBe(true);
    expect(newSecretIsCircuitInput).toBe(true);
  });
});
