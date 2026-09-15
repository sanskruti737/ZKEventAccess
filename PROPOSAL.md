# Product Proposal

## What is the product, and who uses it?

**ZK Event Access** is a privacy-preserving event access-credential ledger built
on Midnight. Event organizers issue a fixed number of access credentials for an
event, and anyone — attendee, sponsor, validator, or auditor — can cryptographically
verify **how many** credentials are outstanding without ever learning **who** holds
them or when they were issued.

- **Organizers** use the dApp to issue and revoke credentials with a single
  organizer-only circuit call. Their secret key never leaves their device.
- **Attendees and auditors** read the public credential count and every proof
  that a state transition was authorized — fully auditable, fully anonymous.
- **Anyone without a wallet** can still view the public state (count,
  organizer commitment, announcements) and trust it is correct.

## Why Midnight specifically?

Midnight is the only chain whose smart-contract language (**Compact**) is
*private by default*, with zero-knowledge proofs generated **locally**, in the
browser. This product would be impossible or much weaker on a transparent
chain:

- On a transparent chain, authorization logic that proves "I am the organizer"
  either leaks the secret (by putting it on-chain) or forces trust in a
  centralized server. Midnight lets the browser generate a succinct ZK proof
  that the caller knows the secret key matching a public `persistentHash`
  commitment — without ever disclosing the key.
- The public/private split matches the product's needs exactly: the **count**
  must be public (auditable issuance caps), but the **key and witnesses** must
  be private (never visible in logs, UI, or network traffic).
- Cost and UX are practical: proofs are created client-side (using the local
  Docker proof server during development, wallet-managed proof serving in
  production) and submitted via the Lace wallet with normal transaction
  balancing.

## Data Model

| Data Point | Type           | Disclosed To |
|------------|----------------|--------------|
| `counter` — number of issued credentials | Public ledger state (`Uint<64>`) | Everyone |
| `organizer` — domain-separated hash commitment to the organizer's key | Public ledger state (`Bytes<32>`) | Everyone (it is an opaque hash; the key stays hidden) |
| `announcement` — latest event message | Public ledger state (string) | Everyone |
| Authorization proofs — valid ZK proof that a state transition was permitted | On-chain proof records | Everyone (the proof reveals authorization, not identity) |
| Organizer secret key (32 bytes) | Private witness (browser private-state provider) | No one |
| Circuit arguments / witnesses | Private (`persistentHash(domain ‖ key)`) | No one |

## Mainnet Feasibility

Yes — realistic to reach Mainnet by Level 6. The circuit, deployment, proof
generation, and browser dApp all already work end-to-end on **Preprod**
(contract `fb24191c6928e59a9490942d6343fb6facfb5a19965c1f85096c06c78af6fc8e`,
live demo https://zkevent-access.vercel.app).

Remaining steps are largely configuration and hardening rather than new
research:

1. **Wallet funding / fees:** swap the faucet tNIGHT for real Mainnet tNIGHT;
   keep transaction costs per credential issuance modest and predictable.
2. **Proof serving:** move from the local Docker proof server to a
   production-grade, wallet-managed prover endpoint with rate limiting and
   monitoring.
3. **Key management:** add a clear onboarding flow for organizers to generate
   and back up the 32-byte key at deployment time (optional multi-signature /
   threshold organizer key).
4. **Convention / legality of an access-cap ledger:** no personal data is
   stored on-chain, only a count and a commitment, which keeps the product
   simple to operate under data-protection rules.
5. **dApp polish and audit:** contract + circuit audit, CI/CD hardening, and a
   commercial distribution plan for the organizer onboarding process.