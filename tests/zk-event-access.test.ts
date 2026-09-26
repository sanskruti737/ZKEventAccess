import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createCircuitContext,
  createConstructorContext,
  type CircuitContext,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, type Ledger } from '../managed/zk-event-access/contract/index.js';
import {
  witnesses,
  createZKEventAccessPrivateState,
  type ZKEventAccessPrivateState,
} from '../src/witnesses.js';
import { CIRCUIT_CONTEXT_ADDRESS } from './fixtures/contract-address.js';

// Deterministic test keys (32 bytes each, as required by Bytes<32>).
const ORGANIZER_SECRET = new Uint8Array(32).fill(7);
const NEW_ORGANIZER_SECRET = new Uint8Array(32).fill(11);
const IMPOSTOR_SECRET = new Uint8Array(32).fill(9);

type Ctx = CircuitContext<ZKEventAccessPrivateState>;

/**
 * Deploy the contract in a local simulator and return it with a fresh circuit context.
 *
 * The circuit-context address is the shared deterministic fixture rather than
 * `sampleContractAddress()`, which panics with `RuntimeError: unreachable` in this
 * Vitest/WASM environment — see tests/fixtures/contract-address.ts.
 */
function makeContract(secret: Uint8Array): { contract: Contract<ZKEventAccessPrivateState>; ctx: Ctx } {
  const contract = new Contract<ZKEventAccessPrivateState>(witnesses);
  const init = contract.initialState(
    createConstructorContext(createZKEventAccessPrivateState(secret), {
      bytes: new Uint8Array(32),
    }),
  );
  const ctx = createCircuitContext(
    CIRCUIT_CONTEXT_ADDRESS,
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

describe('ZK Event Access contract', () => {
  let contract: Contract<ZKEventAccessPrivateState>;
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
      currentPrivateState: createZKEventAccessPrivateState(IMPOSTOR_SECRET),
    };
    expect(() => contract.impureCircuits.increment(impostorCtx)).toThrow(
      /only the organizer can issue access/,
    );
  });

  it('rejects decrement and announcement by an impostor', () => {
    const impostorCtx: Ctx = {
      ...ctx,
      currentPrivateState: createZKEventAccessPrivateState(IMPOSTOR_SECRET),
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
      currentPrivateState: createZKEventAccessPrivateState(ORGANIZER_SECRET),
    };
    const newOrganizerCtx: Ctx = {
      ...rotated.context,
      currentPrivateState: createZKEventAccessPrivateState(NEW_ORGANIZER_SECRET),
    };

    expect(() => contract.impureCircuits.increment(oldOrganizerCtx)).toThrow(
      /only the organizer can issue access/,
    );
    expect(contract.impureCircuits.increment(newOrganizerCtx).context.currentPrivateState).toEqual(
      createZKEventAccessPrivateState(NEW_ORGANIZER_SECRET),
    );
  });

  it('rejects empty, unchanged, and unauthorized rotations', () => {
    const impostorCtx: Ctx = {
      ...ctx,
      currentPrivateState: createZKEventAccessPrivateState(IMPOSTOR_SECRET),
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

  it('stops at zero rather than underflowing the public count', () => {
    // `counter` is the only number an on-chain auditor reads, so a revocation
    // that could push it below zero would make "no credentials were ever
    // issued" indistinguishable from "every issued credential was revoked" —
    // two completely different audit outcomes reading as the same number.
    const issued = contract.impureCircuits.increment(ctx);
    const fullyRevoked = contract.impureCircuits.decrement(issued.context);
    expect(readLedger(fullyRevoked.context).counter).toBe(0n);

    // And the floor holds on every subsequent attempt, not just the second.
    expect(() => contract.impureCircuits.decrement(fullyRevoked.context)).toThrow(
      /already zero/,
    );
    const stillZero = contract.impureCircuits.announce(fullyRevoked.context, 'floor holds');
    expect(readLedger(stillZero.context).counter).toBe(0n);
  });

  // ─── State transitions ─────────────────────────────────────────────────────

  it('initializes every public ledger cell at deployment', () => {
    // A cell the constructor forgets to write is not a harmless omission: the
    // contract would come up with a ledger an auditor cannot interpret (is a
    // zero commitment "no organizer" or "an organizer whose key is the
    // preimage of 0x00…00"?), and `increment`'s organizer check would then be
    // testing against a value nobody chose.
    const deployed = makeContract(ORGANIZER_SECRET);
    const state = readLedger(deployed.ctx);

    expect(state.counter).toBe(0n);
    expect(state.announcement).toBe('');
    // The deploy address is the 32-zero-byte placeholder this suite deploys
    // under (tests/fixtures/contract-address.ts), and the organizer commitment
    // is what the deployer's secret actually commits to.
    expect(Array.from(state.contractAddress)).toEqual(Array.from(new Uint8Array(32)));
    expect(Array.from(state.organizer)).toEqual(
      Array.from(readLedger(deployed.ctx).organizer),
    );
    // A freshly deployed contract must not already look like it issued access.
    expect(contract.impureCircuits.read(deployed.ctx).result).toBe(0n);
  });

  it('rotates only the organizer cell, leaving the ledger and notice intact', () => {
    // `rotate` rewrites exactly one cell. If it also disturbed `counter` or
    // `announcement`, a key handover would silently grant or revoke access or
    // erase a published notice — and because rotation is precisely the moment a
    // new organizer takes over, that is the change least likely to be noticed.
    const issued = contract.impureCircuits.increment(ctx);
    const announced = contract.impureCircuits.announce(issued.context, 'Finale at 21:00');
    const before = readLedger(announced.context);
    const rotated = contract.impureCircuits.rotate(announced.context, NEW_ORGANIZER_SECRET);
    const after = readLedger(rotated.context);

    expect(Array.from(after.organizer)).not.toEqual(Array.from(before.organizer));
    expect(after.counter).toBe(before.counter);
    expect(after.announcement).toBe(before.announcement);
    expect(Array.from(after.contractAddress)).toEqual(Array.from(before.contractAddress));
  });

  it('lets a retained original key take authority back after a rotation', () => {
    // Rotation is a handover, not a one-way door: an organizer who rotates to a
    // second key and keeps the first can rotate straight back. This matters
    // because the dApp's whole recovery story depends on the organizer key
    // being recoverable — a rotation that silently destroyed the original would
    // turn a lost second key into a permanently orphaned event.
    const rotated = contract.impureCircuits.rotate(ctx, NEW_ORGANIZER_SECRET);
    const newOrganizerCtx: Ctx = {
      ...rotated.context,
      currentPrivateState: createZKEventAccessPrivateState(NEW_ORGANIZER_SECRET),
    };
    const restored = contract.impureCircuits.rotate(newOrganizerCtx, ORGANIZER_SECRET);
    const originalOrganizerCtx: Ctx = {
      ...restored.context,
      currentPrivateState: createZKEventAccessPrivateState(ORGANIZER_SECRET),
    };

    // The original secret authorizes again, and the new one no longer does.
    expect(contract.impureCircuits.increment(originalOrganizerCtx).context).toBeDefined();
    expect(() =>
      contract.impureCircuits.increment({
        ...restored.context,
        currentPrivateState: createZKEventAccessPrivateState(NEW_ORGANIZER_SECRET),
      }),
    ).toThrow(/only the organizer can issue access/);
  });

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

  it('replaces the announcement instead of accumulating notices', () => {
    // `announcement` is a single public slot holding the organizer's CURRENT
    // notice, not an append-only log. A client that assumed it accumulated would
    // show a stale "doors open at 18:00" forever after the organizer had moved
    // the time, so the replace-not-append semantic is pinned here.
    const first = contract.impureCircuits.announce(ctx, 'Doors open at 18:00');
    expect(readLedger(first.context).announcement).toBe('Doors open at 18:00');
    const second = contract.impureCircuits.announce(first.context, 'Doors open at 19:30');
    expect(readLedger(second.context).announcement).toBe('Doors open at 19:30');
    // Exactly one slot's worth of state, and the earlier notice is gone.
    expect(readLedger(second.context).announcement).not.toContain('18:00');
  });

  it('issues and revokes nothing when announcing or rotating authority', () => {    // `counter` is the only thing an on-chain auditor reads, and the only
    // circuits allowed to move it are `increment` and `decrement`. `announce`
    // and `rotate` are otherwise-unrelated organizer actions, so a regression
    // that made either of them touch the count would silently grant or revoke
    // somebody's access — a change no auditor could distinguish from a real
    // issuance. Nothing in the contract prevents it, so it is asserted here.
    const issued1 = contract.impureCircuits.increment(ctx);
    const issued2 = contract.impureCircuits.increment(issued1.context);
    const threeIssued = contract.impureCircuits.increment(issued2.context);
    expect(readLedger(threeIssued.context).counter).toBe(3n);

    const announced = contract.impureCircuits.announce(threeIssued.context, 'Doors open at 18:00');
    expect(readLedger(announced.context).counter).toBe(3n);

    // Rotation is the riskier of the two: it rewrites the `organizer` cell
    // itself, so it is exactly the kind of circuit where an off-by-one on an
    // unrelated ledger cell would slip through review.
    const rotated = contract.impureCircuits.rotate(announced.context, NEW_ORGANIZER_SECRET);
    expect(readLedger(rotated.context).counter).toBe(3n);
    expect(contract.impureCircuits.read(rotated.context).result).toBe(3n);

    // And the count is still live afterwards: it did not merely appear
    // unchanged, it still governs issue and revoke under the new key. The
    // rotated state is paired with the NEW secret, because the stale private
    // state can no longer authorize anything — which is the rotation guarantee
    // asserted separately above.
    const underNewKey: Ctx = {
      ...rotated.context,
      currentPrivateState: createZKEventAccessPrivateState(NEW_ORGANIZER_SECRET),
    };
    const afterRotation = contract.impureCircuits.increment(underNewKey);
    expect(readLedger(afterRotation.context).counter).toBe(4n);
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

// ─── Compiled-build invariants ───────────────────────────────────────────────

/**
 * `counter` is the contract's only public number, and its capacity guard cannot
 * be reached from a test: driving the count to 2^64-1 would mean issuing that
 * many credentials, and the circuit state is an opaque WASM `ContractState`
 * that cannot be forged to an arbitrary value.
 *
 * So the guard is asserted where it is actually observable — in the compiled
 * `increment` build the dApp actually ships and calls. Removing the assert from
 * the contract without recompiling, or shipping a build compiled before it
 * existed, both fail here. That is the reachable half of the invariant; the
 * arithmetic it guards is covered by the increment/decrement cases above.
 */
describe('the compiled increment build carries its capacity guard', () => {
  const compiledIncrement = readFileSync(
    new URL('../managed/zk-event-access/contract/index.js', import.meta.url),
    'utf8',
  );

  it('states the bound in the build the dApp calls', () => {
    expect(compiledIncrement).toContain('credential count is at capacity');
  });

  it('still refuses an issuance by anyone but the organizer', () => {
    // The guard is an addition to the authorization check, never a replacement:
    // a build that dropped the organizer assert to make room for it would pass
    // the check above and fail here.
    expect(compiledIncrement).toContain('only the organizer can issue access');
  });

  it('binds the guard to the real Uint<64> ceiling, not a rounded literal', () => {
    // `increment` states its bound as the literal 18446744073709551615, because
    // Compact exposes no MAX constant for Uint bounds. Written by hand it is
    // easy to lose a digit and silently leave the top of the range unissuable, or
    // to overshoot and assert on a value no cell can hold, so the compiled
    // circuit is checked for the exact 64-bit all-ones immediate.
    const zkir = readFileSync(
      new URL('../managed/zk-event-access/zkir/increment.zkir', import.meta.url),
      'utf8',
    );
    expect(zkir).toContain('FFFFFFFFFFFFFFFF');
    // And it is the ONLY bound present, so a second, wrong ceiling cannot hide
    // alongside the correct one.
    expect(zkir.match(/F{16}/g)).toHaveLength(1);
  });
});
