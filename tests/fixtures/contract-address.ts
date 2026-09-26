/**
 * The single deterministic contract-address fixture shared by every test suite
 * that drives the real Compact contract in-process.
 *
 * It replaces `sampleContractAddress()`, which panics with
 * `RuntimeError: unreachable` inside the Vitest/WASM environment these suites run
 * in — a failure that is environmental, not a defect in the contract, the
 * commitment formula, or the deployment lifecycle under test. Note that the
 * lifecycle itself is NOT mocked away: `Contract.initialState` and
 * `contract.impureCircuits.*` still run through the real Compact runtime, and the
 * constructor, ledger cells, organizer commitment and organizer assert are all
 * genuinely exercised. Only the address the circuit context is built around is
 * fixed.
 *
 * The fixture is a fixed constant on purpose:
 *
 *   - deterministic: identical on every run, on every machine;
 *   - exactly 32 bytes: 64 hex characters, no `0x` prefix — the shape
 *     `assertIsContractAddress`, and therefore the SDK itself, requires;
 *   - valid for the contract-address type the code passes to
 *     `createCircuitContext` (asserted in
 *     tests/wallet-backed-deploy.test.ts, "the deterministic contract-address
 *     fixture");
 *   - independent of `sampleContractAddress()`, the network, a node, an indexer
 *     and a wallet;
 *   - not a production address: it is not a deployed preprod/mainnet contract and
 *     is never sent anywhere;
 *   - it does not change what the constructor commits. The ledger's
 *     `contractAddress` cell holds the address-independent 32-zero-byte
 *     placeholder, so the organizer commitment is identical for this fixture and
 *     for any real address (pinned by the "off-chain organizer commitment mirrors
 *     the contract exactly" suite in tests/organizer-commitment.test.ts).
 *
 * It lives in its own module — not inside one test file — so the value has
 * exactly one definition. A test file cannot be imported for this: its
 * top-level `describe()` calls would register that file's whole suite inside the
 * importing file.
 */
export const CIRCUIT_CONTEXT_ADDRESS = '5ec0'.repeat(16);
