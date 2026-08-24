# ZKEventAccess

> A Midnight smart contract that counts event access credentials publicly while keeping the organizer's signing key fully private via zero-knowledge proofs.

## Contract Address

| Network  | Address                                                              |
|----------|----------------------------------------------------------------------|
| Preprod  | `255cd049fd96d934f9fc4880405d9a28fbd924eefc1cb562f9b6eb70ac3cf9c3`   |

## What This Does

ZKEventAccess is an access-credential ledger for events. An **organizer** issues
(`increment`) and revokes (`decrement`) access credentials, and can publish a
public announcement. Anyone can audit **how many** credentials currently exist,
because the count is public on-chain state.

The twist: proving *you are the organizer* requires knowing a secret key — but
that key never touches the chain. Each organizer-only circuit takes the secret
key as a **private witness**, hashes it inside the ZK circuit, and proves the
hash matches a public commitment stored at deployment. Zero-knowledge proofs
verify every state transition; observers learn nothing about the key.

Circuits:

| Circuit      | Access     | Effect                                              |
|--------------|------------|-----------------------------------------------------|
| `increment`  | organizer  | `counter += 1` (issue one credential)               |
| `decrement`  | organizer  | `counter -= 1` (revoke one credential, floor of 0)  |
| `announce`   | organizer  | publishes a string via explicit `disclose()`        |
| `read`       | public     | returns the current credential count                |

## Privacy Model

- **What is PUBLIC (on-chain, visible to anyone):**
  - `counter` — how many access credentials are currently issued (`Uint<64>`)
  - `organizer` — a domain-separated hash commitment to the organizer's key (`Bytes<32>`)
  - `announcement` — the latest announcement string, published deliberately
  - Every proof that a state transition was authorized

- **What is PRIVATE (private witness, never on-chain):**
  - The organizer's 32-byte secret key, supplied off-chain by the
    `organizerSecret()` witness from local private state
  - All circuit arguments by default (Compact is private-by-default)

- **What the user PROVES without revealing:**
  - That they know the secret key whose `persistentHash(domain ‖ key)` equals
    the public `organizer` commitment — i.e. "I am the organizer" — plus that
    the counter arithmetic is correct, all inside a succinct ZK proof.

## Tech Stack

- [Midnight network](https://midnight.network) (preprod testnet — deployed)
- [Compact](https://docs.midnight.network/compact/) — Midnight's zero-knowledge smart-contract language
- Node.js v22, npm
- Docker (runs the local proof server)
- TypeScript, [vitest](https://vitest.dev) for the test suite
- `@midnight-ntwrk/compact-runtime` (contract simulation), `@midnight-ntwrk/midnight-js-*` + `wallet-sdk` (deployment)

## Prerequisites

- Node.js **v22** (`nvm install 22 && nvm use 22`)
- Docker running
- Compact compiler: `npm install -g @midnight-ntwrk/compact-compiler`
- Proof server image: `docker pull midnightnetwork/proof-server`

## Setup

```bash
# 1. Clone
git clone https://github.com/sanskruti737/ZKEventAccess.git
cd ZKEventAccess

# 2. Use Node 22
nvm use 22

# 3. Install dependencies
npm install

# 4. Start the proof server (local, port 6300)
docker run -d --name midnight-proof-server -p 6300:6300 midnightnetwork/proof-server

# 5. Compile the contract (generates managed/counter with circuits + keys)
npm run compile

# 6. Run the test suite
npm test

# 7. Deploy to a testnet (creates a wallet, waits for faucet funding).
#    This repo is deployed on preprod; use --network preprod (or preview):
npm run deploy -- --network preprod
```

The deploy script prints a wallet address to fund at the faucet for the chosen network, e.g. preprod:
`https://midnight-tmnight-preprod.nethermind.dev`
It then registers NIGHT for DUST generation and submits the deployment
transaction, printing the final contract address.

Useful extras:

```bash
npm run check-balance -- --network preprod   # wallet balance
npm run network preview                      # show/set active network
```

## Run Tests

```bash
npm test
```

9 tests cover three areas:

1. **Circuit logic** — counter starts at zero; organizer can increment;
   impostors (wrong secret key) are rejected; decrement below zero is rejected.
2. **State transitions** — chained issue/revoke sequences produce correct
   counts; transitions persist in the public ledger; announcements are stored
   only through explicit `disclose()`.
3. **Privacy guarantees** — only a hash *commitment* of the organizer key is
   stored (deterministic per key, different across keys); the raw secret never
   appears in any public artifact (ledger state, proof outputs, public
   transcripts, or transaction effects), while being present in the private
   proof inputs.

## Initial Idea

I planned to build a privacy-preserving event access system using Midnight and
Compact. The system allows authorized users to prove their eligibility to access
an event without publicly revealing their private information. The project uses
zero-knowledge proofs and witnesses to keep sensitive data private while
verifying access securely.

## Screenshots

### Contract compilation (`compact compile`)

![Compact compile output](docs/screenshot-compile.svg)

### Deployment to Midnight Preprod

Contract address: `255cd049fd96d934f9fc4880405d9a28fbd924eefc1cb562f9b6eb70ac3cf9c3`

![Deploy output](docs/screenshot-deploy.svg)
