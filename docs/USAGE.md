# How to Use ZK Event Access

## What You Need

1. **A Lace Midnight wallet** (or the 1AM wallet). Install the browser
   extension from [lace.io](https://lace.io), then create or import a wallet
   on the **Preprod** test network.
2. **A little test money (tNIGHT)**. Ask for free test funds from the Midnight
   faucet: https://midnight-tmnight-preprod.nethermind.dev — send tNIGHT to
   your wallet address.
3. **The event link**. Open the live dApp at
   https://zkevent-access.vercel.app (or run it locally — see the README).

## Step-by-Step Guide

1. Open the dApp in your browser and **connect your wallet** by clicking
   "Connect Wallet" and approving the request in Lace.
2. The page shows the **public credential count** straight from the Midnight
   chain. This number, plus the latest announcement, is visible to anyone and
   can be independently audited.
3. If you are the **event organizer**, paste your 64-character organizer key
   in the "Organizer Secret Key" box and click **Save Key**. This key is the
   one generated at contract deployment (see your project's `.organizer-key`
   file) — it never leaves your device.
4. Click **Issue credential (+1)** to issue access for one more attendee. A
   zero-knowledge proof is generated *locally in your browser*, then the
   proof is submitted on-chain through your wallet.
5. Watch the counter on-chain increase after your transaction is finalized.
6. To verify how many credentials are currently issued, click **Verify access
   (read)** — this also runs as a local proof + on-chain call.
7. That's it. Anyone can audit the count; nobody can see *who* holds a
   credential or *when* it was issued.

## What Gets Proved (and What Stays Private)

- **Public (anyone can see):** how many access credentials are currently
  issued, a hash *commitment* to the organizer's key, any deliberately
  published announcement, and a record of every authorization proof.
- **Private (never on-chain):** the organizer's 32-byte secret key and all
  sensitive circuit inputs. They exist only as private state inside your
  browser.
- **What gets proved without revealing:** that the person issuing a credential
  really is the organizer — i.e. they know the secret key matching the public
  commitment — without revealing the key itself.

## Troubleshooting

- **"Your local organizer key does not match the on-chain key."** The key you
  saved is not the one bound to the deployed contract. Paste the exact
  64-character hex key from the deployment (`.organizer-key`), then click
  Save Key and reload. If it still fails, check with the deployment logs which
  key was used when the contract address was created.
- **"Key must be exactly 64 hexadecimal characters."** Make sure you pasted
  all 64 hex characters (0-9, a-f) with no spaces or line breaks.
- **"No Midnight wallet detected."** Install and unlock Lace, then refresh.
  If multiple Midnight wallet extensions are installed, keep only one enabled.
- **"Wallet is on the wrong network."** Switch your Lace wallet to the
  Midnight **Preprod** network and try again.
- **The counter doesn't refresh after a call.** Transactions need to be
  finalized on-chain first — wait a few seconds; the count updates live from
  the indexer.