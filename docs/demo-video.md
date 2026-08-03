# Demo video — shot list

> **A rendered video already exists:** https://youtu.be/YErtSWpK8J8
> (1:42, narrated, 1080p), built as an animated piece from the real captured screens and the live
> on-chain data. This document is the shot list for a **screen-recorded** version — useful if you
> want a take that shows a human driving the wallet in real time, which the animated cut does not.
> The two are alternatives, not sequential steps.

A 1–2 minute walkthrough. Target **1:45**.

The submission is judged on complexity and execution, so the video has one job:
show that the money is real and that the architecture is doing something a single
contract could not. Everything else is filler.

---

## Before recording

```sh
# 1. Contracts and frontend green
cd contracts && cargo test --workspace          # keep this terminal, shot 6 uses it
cd ../frontend && npm run test:run && npm run build && npm start
```

- Two testnet wallets in Freighter, both funded from friendbot. Call them
  **Client** and **Worker**.
- Copy the Worker's `G…` address to the clipboard before you start.
- Open the GitHub Actions tab on a green run in a second browser tab.
- Browser at 1440×900, zoom 100%, bookmarks bar hidden.
- Create the deal for **20 XLM over 2 milestones** so each approval is a clean
  10 XLM and the value bar moves in obvious halves.

Record at 1080p or better. No music — the transaction confirmations carry the
pacing.

---

## Shots

### 1 — The claim (0:00–0:12)

**Screen:** dashboard at rest, overview panel visible.

> "StellarPact is milestone escrow on Stellar. A client locks XLM into a contract
> that exists for one deal, and it releases as the work lands."

Scroll slightly so *"How a deal moves"* and the three deployed contract addresses
are both on screen. Pause a beat on the addresses.

---

### 2 — Connect (0:12–0:22)

**Screen:** click **Connect wallet**.

> "Six wallets through StellarWalletsKit."

Let the picker sit for ~1.5s so xBull, Albedo, Freighter, Rabet and LOBSTR are all
legible. Pick Freighter, approve. Balance appears in the header.

---

### 3 — Create a deal (0:22–0:42)

**Screen:** **New deal** → fill the form.

> "Creating a deal doesn't write a row in a table. The registry deploys a brand
> new escrow contract for this deal — a contract deploying a contract."

Paste the Worker address, title *"Landing page redesign"*, 20 XLM, 2 milestones.
Submit. **Stay on the transaction pipeline** — let Simulate → Sign → Submit →
Confirm play through. The new deal opens automatically.

---

### 4 — Fund it (0:42–0:56)

**Screen:** click **Fund 20 XLM**.

> "Funding moves real XLM through the native asset contract. The wallet is
> signing a nested authorization tree, not a single call."

After it confirms, point at the value bar.

> "Blue is money held by the contract. Nothing is released yet."

---

### 5 — Deliver and release (0:56–1:22)

Switch Freighter to the **Worker** account, reload.

**Screen:** *Submit this milestone* → note *"Wireframes delivered"* → submit.

Switch back to **Client**, reload.

**Screen:** **Approve and release 10 XLM**.

> "Each approval releases that milestone's share."

**Point at the value bar filling to half gold.**

> "Gold is money that has reached the worker."

Now the second milestone, worker then client. On the final approval:

> "That last approval does three things in one transaction: it pays the worker,
> it completes the deal, and the escrow writes the worker's reputation — which
> calls back into the registry to check the escrow is real. Escrow, to
> reputation, to registry."

Bar fills fully gold. **Worker record** updates in place.

---

### 6 — Proof (1:22–1:45)

**Screen:** expand the **Activity** tape.

> "Every one of those is a contract event, streamed live."

Click the explorer icon on *Milestone 2 approved* → Stellar Expert opens on the
real transaction. Let the events list render.

Cut to the terminal:

```
test result: ok. 19 passed    test result: ok. 12 passed
test result: ok.  8 passed    test result: ok.  8 passed
 Tests  86 passed (86)
```

> "133 tests. One of them deploys byte-identical escrow code outside the factory
> and proves it still can't write reputation — and that the payout rolls back
> with it."

Cut to the green GitHub Actions run. Hold 2s. End.

---

## If you only have 60 seconds

Keep shots 3, 5 and 6. Drop the wallet picker and open on an already-funded deal.
The two things that must survive any cut are **the value bar filling** and **the
final approval writing reputation**.

---

## Things to get right

- **Don't cut the transaction confirmations.** Watching Simulate → Sign → Submit
  → Confirm actually resolve is the proof it is a real network.
- **Say "deploys a contract" out loud** on shot 3. It is the least obvious and
  most impressive thing in the project.
- **Show the explorer at least once.** It converts "nice UI" into "real chain".
- Don't narrate the colour scheme. Point at the bar; it explains itself.

---

## After recording

Upload to YouTube or Loom, then put the link in:

- the README **Submission** table (`Demo video` row)
- the challenge submission form

The animated cut already shipped this way — https://youtu.be/YErtSWpK8J8, with
the source MP4 and the derived assets kept in [`demo/`](demo/).
