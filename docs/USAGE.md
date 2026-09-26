# How to Use ZK Event Access

## What You Need

1. **The 1AM Midnight wallet** — any Midnight dapp-connector wallet extension.
   Install and unlock it in your browser, with an account on the **Preprod**
   test network.
2. **A little test money (tNIGHT)**. Ask for free test funds from the Midnight
   faucet: https://midnight-tmnight-preprod.nethermind.dev — send tNIGHT to
   your wallet address.
3. **The event link**. Open the live dApp at
   https://zkevent-access.vercel.app (or run it locally — see the README).

> **You never paste a secret key.** There is no key box anywhere in this app.
> Your organizer identity is derived from your connected wallet and kept in
> your browser's private storage. If any page asks you to paste a key to use
> ZK Event Access, it is not this app.

## Step-by-Step Guide

### 1. Connect your wallet

Click **Connect 1AM wallet** and approve the connection request in the wallet
extension. The header then shows your wallet name and a shortened copyable
address. You can **Disconnect wallet** at any time.

If the page reports **"No Midnight wallet detected"**, install and unlock 1AM
and refresh. If several Midnight extensions are installed, enable only one —
they conflict.

### 2. Deploy a wallet-backed event (organizer only)

Fresh browsers have no event yet. The status line will read **"No verified
event yet"**, and *Issue credential* and *Verify access* will tell you they
need a wallet-backed event.

Click **Deploy a new wallet-backed event** and approve the transaction in 1AM.
The dApp then:

1. deploys the contract on Preprod,
2. reads the new event's `organizer` commitment back from the indexer,
3. compares it against the commitment your wallet produces, and
4. only then records the event as active.

A deployment costs a real transaction fee, so it is **never** started
automatically — it happens only when you click the button.

### 3. Issue a credential

Click **Issue credential**. The dApp generates a zero-knowledge proof **locally
in your browser** proving you know the organizer secret without revealing it,
then submits the proof through your wallet.

If the wallet already has an unconfirmed transaction, the app waits and says so
rather than submitting a second one — 1AM accepts one transaction at a time.
**Verify access** keeps working throughout, because it submits nothing.

### 4. Verify access

Click **Verify access** to read the current public credential count. This is a
direct query against the public indexer: **no proof is generated and no
transaction is submitted**, so it never competes for the wallet's pending slot
and cannot be rejected for being "too busy".

### 5. That's it

Anyone can audit the count. Nobody can see *who* holds a credential or *when*
it was issued.

## What Gets Proved (and What Stays Private)

- **Public (anyone can see):** how many access credentials are currently
  issued, the address the event was deployed under, a hash *commitment* to the
  organizer's key, any deliberately published announcement, and a record of
  every authorization proof.
- **Private (never on-chain):** the organizer's 32-byte secret key and all
  sensitive circuit inputs. They exist only as private state inside your
  browser.
- **What gets proved without revealing:** that the person issuing a credential
  really is the organizer — i.e. they know the secret key matching the public
  commitment — without revealing the key itself.

## Troubleshooting

- **"No event contract address configured."** This browser has no active event
  yet. Click **Deploy a new wallet-backed event**.
- **"This action needs a wallet-backed event."** Same cause, shown as a state
  to move on from rather than a failure. The deploy button is offered right
  there.
- **"The event saved in this browser (…) was deployed from a DIFFERENT build of
  the contract."** The saved event was deployed from an older contract version,
  so its on-chain verifier keys do not match this app and its circuits can
  never be called. Nothing was issued. Click **Deploy a new wallet-backed
  event** to register a fresh one.
- **"This browser no longer holds the organizer key for event (…)."** The
  organizer key for that event is not in this wallet's private storage. Because
  the wallet's signature cannot be reproduced, the key cannot be recovered —
  the app will not invent a replacement, as that would destroy it. Deploy a new
  wallet-backed event.
- **"This browser refused to save event (…), so it is active for this page
  only."** The event is real and verified, but the browser would not store its
  address (private/incognito window, storage limit, or a full disk). It works
  until you refresh. Allow site storage for the app and avoid private windows.
- **"The 1AM wallet already has a transaction waiting to be confirmed."** 1AM
  accepts one transaction at a time and refused the request. Nothing was issued
  and nothing changed. Wait for the pending transaction to be included on-chain
  or to expire, then try again.
- **"The counter doesn't refresh after issuing."** The proof has to be finalized
  on-chain first. Wait a few seconds; the count updates live from the indexer.
