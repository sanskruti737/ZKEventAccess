# ZK Event Access

![CI](https://github.com/sanskruti737/ZKEventAccess/actions/workflows/ci.yml/badge.svg)

> A privacy-preserving event access dApp on Midnight: anyone can audit the credential count on-chain, but the organizer's secret key never leaves their device — every state change is proven locally with zero-knowledge proofs and submitted from the browser via 1AM.

## Live Demo

- **Live Web App:** [https://zkevent-access.vercel.app](https://zkevent-access.vercel.app)
- **Video Walkthrough:** [Click here to watch the live demo](https://drive.google.com/file/d/1tNhJQMC3benbvTU1CxF0gux03AjrP0vU/view?usp=sharing)

## Contract Address

| Network | Address | Status |
|---------|---------|--------|
| Preprod | `fb24191c6928e59a9490942d6343fb6facfb5a19965c1f85096c06c78af6fc8e` | **Stale build — redeploy required** |

> ### ⚠️ The deployed Preprod contract predates the current contract source
>
> This address is live and verified on-chain, but it was deployed from an
> **older build** of `contracts/zk-event-access.compact` and cannot serve the
> current dApp. Verified against the Preprod indexer:
>
> - Deployed by transaction `b9c538d630e234ee5f9299f7798fbed5b40695ff989b426a9706eed7aff1ad5d`
>   in block `241872ade505a40115c7655884455fd0f15735324cca0cda8c25d14926d0e3e2`
>   (height 2599874, 2026-09-18T06:11:42Z).
> - The deployed contract's on-chain state carries the circuits `increment`,
>   `decrement`, `announce` and `read` — and **no `rotate`**.
> - `rotate`, the address-bound `publicKey` commitment
>   (`persistentHash(domain ‖ contractAddress ‖ sk)`) and the `contractAddress`
>   ledger cell were all added in `d56eb0a`, on 2026-09-25 — seven days *after*
>   that deployment.
>
> Two consequences, both user-visible:
>
> 1. `rotate` does not exist on the deployed instance, so any call to it fails
>    as an unknown circuit.
> 2. The deployed `organizer` cell commits to `persistentHash(domain ‖ sk)`,
>    while the current dApp derives its expected commitment as
>    `persistentHash(domain ‖ contractAddress ‖ sk)`. The two can never match,
>    so the organizer pre-flight check reports a mismatch against this address
>    forever.
>
> **Fix:** deploy a fresh wallet-backed event from the dApp — click **"Deploy a
> new wallet-backed event"**. The dApp deploys, reads the new `organizer` back
> from the indexer, verifies it against the connected wallet, and only then
> records it as the active event. Redeploying costs one real transaction fee per
> event and requires a funded 1AM wallet, so it is deliberately never
> automated.

## What This Does

ZK Event Access is an access-credential ledger for events, deployed on Midnight
preprod and driven entirely from the browser:

1. **Connect** your 1AM Midnight wallet.
2. The dApp joins the deployed contract and displays the **public credential
   count** straight from the chain.
3. **Issue credential (+1)** — the organizer-only circuit. A zero-knowledge
   proof is generated *in your browser* proving you know the organizer secret,
   then submitted on-chain through 1AM.
4. **Verify access (read)** — a public indexer query. It runs **no proof and
   submits no transaction**.

The organizer secret key is derived from the wallet's `signData` capability and
kept in the wallet-scoped private state provider (IndexedDB). It is never
pasted into the page, never placed in `localStorage`, and never sent anywhere.

Circuits:

| Circuit     | Access    | Effect                                             |
|-------------|-----------|----------------------------------------------------|
| `increment` | organizer | `counter += 1` (issue one credential)              |
| `decrement` | organizer | `counter -= 1` (revoke one, floor of 0)            |
| `announce`  | organizer | publishes a string via explicit `disclose()`       |
| `rotate`    | organizer | re-keys organizer authority to a new secret        |
| `read`      | public    | returns the current credential count               |

`increment` refuses to run at the counter's representable maximum, and
`decrement` refuses to run at zero, so the public count can never be driven
past its own type or below it.

### Why "Verify access" does not call the `read` circuit

The `read` circuit exists and is public, but the dApp does not invoke it. It is
`read(): Uint<64> { return counter; }` — no witness, no state change, returning
a value that is *already* public ledger state. Calling it through
`callTx.read()` would cost a full local ZK proof plus a wallet transaction to
obtain a number the indexer hands over for free, and it would spend the 1AM
wallet's single pending-transaction slot to do it. "Verify access" therefore
reads the public count directly from the public data provider: no proof, no
submission, and nothing that can be rejected as "already pending".

## Privacy Model

- PUBLIC:
  - `counter` — how many access credentials are currently issued (`Uint<64>`)
  - `contractAddress` — the address the contract was deployed under (`Bytes<32>`)
  - `organizer` — a domain-separated hash commitment to the organizer's key (`Bytes<32>`)
  - `announcement` — the latest announcement string, published deliberately
  - Every proof that a state transition was authorized
- PRIVATE:
  - The organizer's 32-byte secret key held by the wallet-scoped IndexedDB private state provider — it never appears in the UI, logs, or network traffic
  - All circuit arguments by default (Compact is private-by-default)
- PROVED without revealing:
  - That the caller knows the secret key whose `persistentHash(domain ‖ contractAddress ‖ key)` equals the public `organizer` commitment — i.e. "I am the organizer" — plus that the counter arithmetic is correct, all inside a succinct ZK proof generated locally in the browser.

## Privacy Claim

What an on-chain observer sees vs cannot see:

- **What an observer sees:** The current credential count, the deploy address, the organizer *commitment* (an opaque 32-byte hash), any deliberately published announcement, and valid proofs that transitions were authorized.
- **What an observer cannot see:** The organizer's secret key. An observer cannot derive it from the commitment (domain-separated `persistentHash`, preimage-resistant), cannot forge an increment without it (the circuit fails during local proof generation before anything is sent), and cannot link the key to any address or identity.

## Tech Stack

- [Midnight network](https://midnight.network) — preprod testnet
- [Compact](https://docs.midnight.network/compact/) — zero-knowledge smart-contract language (compiler 0.31.1, language version 0.23)
- Midnight.js SDK (`@midnight-ntwrk/midnight-js-*`) — providers, contract calls, proof submission
- 1AM (any Midnight dapp-connector wallet) — connection, transaction balancing & signing
- React 19 + Vite — frontend
- TypeScript, Vitest (test suite)

## Prerequisites

- A Midnight browser wallet extension — **1AM** — on the preprod network, funded with tNIGHT from the [faucet](https://midnight-tmnight-preprod.nethermind.dev)
- Node.js v22 (`nvm install 22 && nvm use 22`)
- The [Compact compiler](https://github.com/midnightntwrk/compact) 0.31.1 (`npm run compile` fetches nothing; install the CLI first)
- Docker running, if you want the local proof server fallback (1AM normally supplies its own prover)

## Setup & Run Locally

```bash
# 1. Clone & enter
git clone https://github.com/sanskruti737/ZKEventAccess.git
cd ZKEventAccess

# 2. Use Node 22
nvm use 22

# 3. Install dependencies
npm ci

# 4. Compile the contract (generates managed/zk-event-access) and copy ZK assets
npm run compile && npm run copy-zk-assets

# 5. Run the test suite
npm test

# 6. Start the dApp
npm run dev
# → open http://localhost:5173, connect 1AM, then deploy or use an event
```

Notes:
- The prover endpoint normally comes from your 1AM wallet configuration. Set
  `VITE_PROOF_SERVER_URL` to fall back to a local proof server
  (`docker run -d --name midnight-proof-server -p 6300:6300 midnightnetwork/proof-server`).
- **No setup step involves pasting a secret key.** The organizer identity is
  derived from the connected wallet and stored in IndexedDB automatically when
  you deploy an event. (An earlier revision of this README instructed you to set
  a `zkea.organizerKey` localStorage entry by hand; that mechanism no longer
  exists and the app never reads it.)
- The private-state id the organizer key is stored under is deliberately still
  `counterPrivateState`. It is a persistence key, not a label — see the comment
  on `ZK_EVENT_ACCESS_PRIVATE_STATE_ID`. Do not rename it.

## Run Tests

```bash
npm test          # 157 tests
npm run typecheck # tsc --noEmit
```

The 157 tests cover:

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `tests/zk-event-access.test.ts` | 22 | Circuit logic against the real Compact runtime: organizer authorization, counter arithmetic and both bounds, announcement semantics, key rotation and its reversal, ledger initialization, and the privacy guarantee that the witness never reaches a public artifact |
| `tests/organizer-commitment.test.ts` | 18 | The off-chain commitment derivation mirrors the contract's own formula exactly |
| `tests/active-event.test.ts` | 49 | Active-event storage: legacy migration, fail-closed verification, storage that refuses writes, and the in-session mirror |
| `tests/wallet-backed-deploy.test.ts` | 26 | The deploy → verify → activate lifecycle |
| `tests/wallet-backed-event-flow.test.ts` | 24 | The end-to-end event flow, including that verification submits nothing |
| `tests/wallet-transactions.test.ts` | 13 | The wallet's pending-transaction observer |
| `tests/logger.test.ts` | 5 | Log-level filtering, including that `silent` really is silent |

## CI/CD

GitHub Actions runs on every `push` and `pull_request` targeting `main`
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

1. **Checkout** — `actions/checkout@v4`.
2. **Node 22** — `actions/setup-node@v4` with npm caching.
3. **Install dependencies** — `npm ci`, so the build uses the committed
   `package-lock.json` rather than re-resolving the tree.
4. **Compact compiler** — installed via the official installer script, then
   pinned to `0.31.1` with `compact update` so the compiled build is
   reproducible.
5. **`compact compile`** — compiles `contracts/zk-event-access.compact` into
   TypeScript interfaces, proving/verifier keys and ZKIR artifacts.
6. **Typecheck** — `npm run typecheck`. The test suite transpiles TypeScript
   but never type-checks it, so without this a type error in an unimported path
   would reach `main` green.
7. **Build frontend** — `npm run build`. Nothing in `npm test` exercises the Vite
   bundle, and the dApp is the deliverable, so a broken import graph or bundling
   failure is caught here.
8. **Canonical user record** — `npm run check:users`. The prepared Google-Sheet
   upload is generated from `users.xlsx`, so a hand-edit to either drifting
   apart is a data-integrity failure. This reads local files only and needs no
   network, unlike `verify:users-sheet`, which stays out of CI on purpose
   because it depends on Google being up.
9. **Test suite** — `npm test`.

There is no separate deployment job: the dApp is deployed to Vercel from its
own connected project, and contract deployment is a deliberate, wallet-signed
action taken from the dApp rather than from CI.

## Usage Guide

See [docs/USAGE.md](docs/USAGE.md) for a plain-English, step-by-step guide on
connecting a wallet, issuing credentials, and understanding what stays private.

## Product Proposal

See [PROPOSAL.md](PROPOSAL.md)

## Product X Profile

**Product X Profile:** [https://x.com/ZKEventAccess](https://x.com/ZKEventAccess)

Verified live: the handle `@ZKEventAccess` resolves to the **ZK Event Access**
product account ("Privacy-first event access powered by zero-knowledge
technology"), joined September 2026. It currently has **0 posts** — the profile
exists and is correctly branded, but no product content has been published to it
yet.

## Level 5 — User Validation

- Target: 70 Preprod users
- Current: **50 / 70** onboarded

**Canonical onboarded-user record:**
[ZK Event Access — Onboarded Users (Google Sheet)](https://docs.google.com/spreadsheets/d/1CfUq8dCAGiFZ81ChCBPGZsLS5xVqSwLZEoSM-HdF3DY/edit?usp=sharing)

`users.xlsx` is the source that Sheet is built from; the two were verified to
match one-for-one — same 50 people, same emails, same wallet addresses, no rows
on either side missing from the other. The Sheet's `Feedback` and
`Transaction Hash` columns are **empty**: no feedback text or transaction hash
has been recorded against a user, and none has been invented to fill them.

Re-run that verification at any time:

```bash
npm run check:users          # local only: prepared .csv/.tsv vs users.xlsx (this is what CI runs)
npm run verify:users-sheet   # the above, plus a live fetch of the Google Sheet
```

`check:users` reads `users.xlsx` directly and confirms both prepared
representations still match it row for row, so no row can be quietly added,
dropped or edited. It touches no network, which is why it is the variant in CI —
a build must not fail because Google is rate-limiting.

`verify:users-sheet` additionally fetches the live Sheet and asserts it still
matches, **and that the `Feedback` and `Transaction Hash` columns are still
empty**. That last assertion is the point: it is what stops those columns being
filled in with something plausible-looking but made up. Filling them is
legitimate only from real responses, and this script failing is the signal that
it did not happen that way. It stays out of CI for the network reason above.

### What the 50 users actually did

`users.xlsx` carries three validation columns beyond the identity data, and they
are uniform across all 50 respondents:

| Question | Result |
|----------|--------|
| Did you successfully connect your 1 AM wallet? | Yes × 50 |
| Did you successfully issue an access credential? | Yes × 50 |
| Did you successfully verify access? | Yes × 50 |

So all 50 onboarded users completed the full flow — connect, issue, verify — on
their own Preprod wallets. These columns are uniform, so they carry no per-user
signal and are not exported into the Sheet's user-facing columns.

### Known data-quality note

One email is shared by two people: **Somnath chavan** and **Sanskar chavan**
both appear against `somnathchavan230@gmail.com`, with two different Preprod
wallets. This is inherited verbatim from `users.xlsx` (rows 7 and 12) and has
**not** been "corrected", because there is no way to tell which row holds the
mistake and guessing would corrupt the canonical record. Worth confirming with
both users. The check above reports it as a `WARN` on every run so it stays
visible.

### Superseded — do not read these as the user list

| File | What it actually is |
|------|---------------------|
| [`USERS.md`](USERS.md) | Historical wallet-address log. Addresses only, no names or emails, and it carries **51** addresses against the canonical 50. Retired as a source of truth; see the banner in that file. |
| [`users.csv`](users.csv) | Superseded raw form export. 55 rows but only 53 unique addresses: `Aruna chavan`/`Aruna Chavan` is the same person twice, and `Sudhakar Sutar`/`Krishna Maral` are two different people recorded against the *same* shield address. |
| [`docs/FEEDBACK.md`](docs/FEEDBACK.md) | Per-response feedback log (54 responses) with themes and the fixes they drove. A historical log, not a user list. |

## Screenshots

### Contract compilation (`compact compile`)

![Compact compile output](docs/screenshot-compile.svg)

### Deployment to Midnight Preprod

Contract address: `fb24191c6928e59a9490942d6343fb6facfb5a19965c1f85096c06c78af6fc8e`
(stale build — see [Contract Address](#contract-address)).

![Deploy output](docs/screenshot-deploy.svg)

### Live dApp walkthrough

⛔ **This screenshot is not publicly viewable.** The Google Drive file
`17x1JBv00z54lU5T0Bf8wp7Ezfs1yJJUk` is not shared publicly — following the link
returns HTTP 401, and the direct-download endpoint returns a Google **sign-in
page** rather than the image. Fixing this needs the file's sharing changed to
"Anyone with the link"; until then there is no working walkthrough screenshot,
so no link is presented here as if there were.

The dApp itself is reachable and public: <https://zkevent-access.vercel.app>.

## Demo Video

[Demo Video](https://drive.google.com/file/d/1tNhJQMC3benbvTU1CxF0gux03AjrP0vU/view?usp=sharing)
(verified publicly viewable)


