# ZK Event Access

![CI](https://github.com/sanskruti737/ZKEventAccess/actions/workflows/ci.yml/badge.svg)

> A privacy-preserving event access dApp on Midnight: anyone can audit the credential count on-chain, but the organizer's secret key never leaves their device — every state change is proven locally with zero-knowledge proofs and submitted from the browser via Lace.

## Live Demo

- **Live Web App:** [https://zkevent-access.vercel.app](https://zkevent-access.vercel.app)
- **Video Walkthrough:** [Click here to watch the live demo](https://drive.google.com/file/d/1yzNQkpBN6raXf2FTGURV_yN00b_gcxDM/view?usp=drive_link)


## Contract Address

| Network  | Address                                                            |
|----------|--------------------------------------------------------------------|
| Preprod  | `fb24191c6928e59a9490942d6343fb6facfb5a19965c1f85096c06c78af6fc8e` |

## What This Does

ZK Event Access is an access-credential ledger for events, deployed on Midnight
preprod and driven entirely from the browser:

1. **Connect** your Lace Midnight wallet.
2. The dApp joins the deployed contract and displays the **public credential
   count** straight from the chain.
3. **Issue credential (+1)** — the organizer-only circuit. A zero-knowledge
   proof is generated *in your browser* proving you know the organizer secret,
   then submitted on-chain through Lace.
4. **Verify access (read)** — a public circuit call that also runs as a local
   proof + on-chain transaction.

Circuits:

| Circuit      | Access     | Effect                                              |
|--------------|------------|-----------------------------------------------------|
| `increment`  | organizer  | `counter += 1` (issue one credential)               |
| `decrement`  | organizer  | `counter -= 1` (revoke one credential, floor of 0)  |
| `announce`   | organizer  | publishes a string via explicit `disclose()`        |
| `read`       | public     | returns the current credential count                |

## Privacy Model

- PUBLIC:
  - `counter` — how many access credentials are currently issued (`Uint<64>`)
  - `organizer` — a domain-separated hash commitment to the organizer's key (`Bytes<32>`)
  - `announcement` — the latest announcement string, published deliberately
  - Every proof that a state transition was authorized
- PRIVATE:
  - The organizer's 32-byte secret key held by the browser-side private state provider — it never appears in the UI, logs, or network traffic
  - All circuit arguments by default (Compact is private-by-default)
- PROVED without revealing:
  - That the caller knows the secret key whose `persistentHash(domain ‖ key)` equals the public `organizer` commitment — i.e. "I am the organizer" — plus that the counter arithmetic is correct, all inside a succinct ZK proof generated locally in the browser.

## Privacy Claim

What an on-chain observer sees vs cannot see:

- **What an observer sees:** The current credential count, the organizer *commitment* (an opaque 32-byte hash), any deliberately published announcement, and valid proofs that transitions were authorized.
- **What an observer cannot see:** The organizer's secret key. An observer cannot derive it from the commitment (domain-separated `persistentHash`, preimage-resistant), cannot forge an increment without it (the circuit fails during local proof generation before anything is sent), and cannot link the key to any address or identity.

## Tech Stack

- [Midnight network](https://midnight.network) — preprod testnet
- [Compact](https://docs.midnight.network/compact/) — zero-knowledge smart-contract language
- Midnight.js SDK (`@midnight-ntwrk/midnight-js-*`) — providers, contract calls, proof submission
- Lace / 1AM (any Midnight dapp-connector wallet) — connection, transaction balancing & signing
- React 19 + Vite — frontend
- TypeScript, vitest (contract test suite)
- Docker (local proof server for development)

## Prerequisites

- A Midnight browser wallet extension — **Lace** or **1AM** — on the preprod network, funded with tNIGHT from the [faucet](https://midnight-tmnight-preprod.nethermind.dev)
- Node.js v22 (`nvm install 22 && nvm use 22`)
- Docker running (proof server)

## Setup & Run Locally

```bash
# 1. Clone & enter
git clone https://github.com/sanskruti737/ZKEventAccess.git
cd ZKEventAccess

# 2. Use Node 22
nvm use 22

# 3. Install dependencies
npm install

# 4. Start the local proof server (port 6300)
docker run -d --name midnight-proof-server -p 6300:6300 midnightnetwork/proof-server

# 5. Compile the contract (generates managed/counter) and copy ZK assets
npm run compile && npm run copy-zk-assets

# 6. Run the contract test suite (9 tests)
npm test

# 7. Start the dApp
npm run dev
# → open http://localhost:5173, connect Lace, call circuits
```

Notes:
- The prover endpoint comes from your Lace wallet configuration; keep the
  Docker proof server running while using the dApp.
- As the event organizer, you can authorize this browser session by storing
  the deployment-time organizer key once (developer console):
  `localStorage.setItem('zkea.organizerKey', '<64-char hex key>')`.
  The key is kept out of the UI by design — only its hash ever touches the chain.

## Run Tests

```
npm test
```

9 tests cover circuit logic (organizer authorization, counter arithmetic, impostor rejection), state transitions, and privacy guarantees (secret key never appears in public artifacts).

## CI/CD

The automated CI/CD pipeline runs via GitHub Actions on every `push` and `pull_request` targeting the `main` branch.

It executes the following workflow:
1. **Checkout code:** Checks out repository files using `actions/checkout@v4`.
2. **Install Node.js v22:** Sets up Node.js v22 with npm caching via `actions/setup-node@v4`.
3. **npm install:** Installs dependencies from `package.json`.
4. **compact compile:** Installs the Midnight Compact compiler and compiles `contracts/counter.compact` into TypeScript interfaces, proving/verifier keys, and ZKIR artifacts.
5. **Run test suite:** Executes `npm test` running 9 automated tests with Vitest, validating circuit authorization, state transitions, and zero-knowledge privacy guarantees.

## Usage Guide

See [docs/USAGE.md](docs/USAGE.md) for a plain-English, step-by-step guide on
connecting a wallet, issuing credentials, and understanding what stays private.

## Product Proposal

See [PROPOSAL.md](PROPOSAL.md)

## Product X Profile

Follow me on X: [https://x.com/sanskrutichz](https://x.com/sanskrutichz)

## Level 5 — User Validation

- Target: 50 Preprod users
- Current: 51 / 50 (see [USERS.md](USERS.md) for wallet addresses)
- Feedback log and iteration notes: [docs/FEEDBACK.md](docs/FEEDBACK.md)
- Try the live Preprod demo: [https://zkevent-access.vercel.app](https://zkevent-access.vercel.app)

## Screenshots

### Contract compilation (`compact compile`)

![Compact compile output](docs/screenshot-compile.svg)

### Deployment to Midnight Preprod

Contract address: `fb24191c6928e59a9490942d6343fb6facfb5a19965c1f85096c06c78af6fc8e`

![Deploy output](docs/screenshot-deploy.svg)

### Live dApp walkthrough

[View browser flow screenshot](https://drive.google.com/file/d/17x1JBv00z54lU5T0Bf8wp7Ezfs1yJJUk/view?usp=sharing)

## Demo Video

[Demo video](https://drive.google.com/file/d/1DhO3h5IhJ28Tr3_loHWjTRPbYdtYdoSm/view?usp=sharing)

