# Architecture

How StellarPact is put together, and why each part is shaped the way it is.

---

## The problem the shape solves

An escrow holds someone else's money. Two properties follow from that, and
between them they force the design:

1. **A failure in one deal must not be able to touch another deal's balance.**
2. **A reputation record is worthless if the party it describes can write it.**

A single contract holding a table of deals fails the first: one bad storage key,
one arithmetic slip, and every balance in the table is reachable. A reputation
map inside that same contract fails the second: whoever can call the contract can
reach the map.

StellarPact resolves both structurally rather than by being careful.

---

## Contract responsibilities

| Contract | Owns | Deployed |
|---|---|---|
| `registry` | the escrow implementation hash, the index of deployed escrows, admin authority, the pause switch | once |
| `escrow` | exactly one deal: parties, amount, milestones, deadline, status | once **per deal**, by the registry |
| `reputation` | every worker's lifetime record | once |

The escrow is *uploaded* but never deployed by hand. The registry holds its WASM
hash and mints instances on demand.

---

## Call graph

```
                    ┌───────────────────┐
  create_deal ─────▶│ RegistryContract  │──── deploy_v2() ──▶ EscrowContract #n
                    │ (factory + index) │
                    └─────────┬─────────┘
                              │ is_escrow(addr)? ◀──────────────────┐
                              ▼                                     │
  fund() ───────────▶┌───────────────────┐                          │
  submit_milestone()▶│  EscrowContract   │── transfer() ──▶ SAC (native XLM)
  approve_milestone()│  (per-deal state) │                          │
  refund() ─────────▶│                   │                          │
  raise_dispute() ──▶└─────────┬─────────┘                          │
  resolve_dispute() ──┘        │ record(self, worker, amount, ok)   │
                               ▼                                    │
                    ┌───────────────────┐                           │
                    │ReputationContract │───── verifies caller ─────┘
                    └───────────────────┘
```

### Hop 1 — Registry deploys an Escrow

```rust
let escrow = env
    .deployer()
    .with_current_contract(Self::salt_for(&env, index))
    .deploy_v2(escrow_wasm, args);
```

A contract deploying a contract, with constructor arguments, inside the
transaction the client signs. Because the arguments go to `__constructor`, the
escrow is fully configured the moment it exists — there is no window in which a
half-initialised escrow is callable by anyone.

The salt is a monotonic deal index. `with_current_contract` already namespaces
addresses by the deploying contract, so uniqueness only has to hold within this
registry — which a counter guarantees, while keeping escrow addresses
deterministic.

### Hop 2 — Escrow moves XLM through the SAC

```rust
token::TokenClient::new(&env, &deal.token)
    .transfer(&deal.client, &self_address, &deal.total_amount);
```

Real XLM, through the native Stellar Asset Contract. Not a balance tracked in
contract storage.

This is the hop that shapes the frontend. The SAC's own `transfer` calls
`from.require_auth()`, so funding an escrow needs the client's authorization for
a *nested* invocation. Simulation produces that authorization tree and
`assembleTransaction` attaches it, which is why the wallet is asked to sign a
tree rather than one flat call.

### Hops 3 and 4 — Escrow → Reputation → Registry

```rust
// in the escrow, on the final approval
ReputationClient::new(&env, &deal.reputation)
    .record(&self_address, &deal.worker, &deal.total_amount, &true);
```

```rust
// in reputation, inside record
caller.require_auth();
if !RegistryClient::new(&env, &registry).is_escrow(&caller) {
    return Err(ReputationError::NotAnEscrow);
}
```

Two hops deep in one invocation. `caller` is the escrow's own address;
contract-to-contract authorization makes `require_auth` free for a genuine escrow
and impossible to satisfy for anything impersonating one. The registry lookup
then proves the caller was minted by the factory rather than deployed
independently.

**Why both checks are needed.** `require_auth` alone proves the caller is who it
says it is — but anyone can deploy the escrow WASM themselves and be honestly
"an escrow". The registry lookup is what makes the claim mean something.

---

## Authorization model

| Action | Authorised by | Checked how |
|---|---|---|
| `create_deal` | client | `client.require_auth()` |
| `fund` | client | `deal.client.require_auth()` + nested SAC auth |
| `submit_milestone` | worker | `deal.worker.require_auth()` |
| `approve_milestone` | client | `deal.client.require_auth()` |
| `refund` | client | `require_auth()` + deadline elapsed |
| `raise_dispute` | client or worker | `by.require_auth()` + membership check |
| `resolve_dispute` | registry admin | **fetched from the registry at call time** |
| `record` | a registered escrow | `require_auth()` + `registry.is_escrow()` |
| pause, rotate admin, repoint WASM | registry admin | `admin.require_auth()` |

Escrows never store an admin address. `resolve_dispute` asks the registry who the
admin is at the moment it is called, so rotating the admin there takes effect
immediately across every escrow ever deployed — including ones deployed before
the rotation. There is no migration.

---

## Storage and lifetimes

| Contract | Key | Durability | Why |
|---|---|---|---|
| registry | admin, wasm hash, reputation, token, paused, count | instance | small, always needed together |
| registry | `Escrow(u32)`, `IsEscrow(Address)` | persistent | grows without bound; must outlive the instance |
| escrow | `Deal`, `Milestone(u32)` | instance | one deal's whole state, read together |
| reputation | `Score(Address)` | persistent | must outlive any single deal |

Reputation entries are bumped by 90 days whenever touched — a worker's history
should outlive the deals that produced it. Escrow instance state is bumped on
every write for the same reason: a funded escrow whose storage expired would be
a contract holding money nobody can reach.

---

## Money invariants

**The escrow always drains to exactly zero.** Milestones split the total evenly,
and the final one is paid as `total_amount - released` rather than as another
even share. Integer division would otherwise strand stroops in the contract
forever.

```
total 10_000_003 over 3 milestones
  → 3_333_334 + 3_333_334 + 3_333_335 = 10_000_003
```

The frontend mirrors this in `expectedShare` so a milestone's displayed value
matches what it will actually pay, and a test checks the sum for fifty
combinations of amount and milestone count.

**A refund returns only what was never approved.** Work already paid for stays
paid for; `refund` moves `total_amount - released` and nothing more.

---

## Events

Every event across all three contracts is declared with `#[contractevent]` and
carries a shared `pact` prefix topic:

```rust
#[contractevent(topics = ["pact", "approved"])]
pub struct MilestoneApproved {
    #[topic] pub worker: Address,
    #[topic] pub index: u32,
    pub amount: i128,
    pub released: i128,
}
```

That prefix exists for one reason. Escrows are deployed on demand, so their
addresses are not knowable in advance and cannot be listed in a contract-id
filter. Filtering on the topic instead subscribes to all three contracts *and* to
escrows that do not exist yet:

```ts
filters: [
  { type: 'contract', topics: [[PACT, '*']] },
  { type: 'contract', topics: [[PACT, '*', '*']] },
  { type: 'contract', topics: [[PACT, '*', '*', '*']] },
]
```

Soroban matches topic filters by exact segment count, hence one filter per event
arity — StellarPact events carry two to four topics, and Soroban caps an event at
four.

---

## Frontend architecture

```
components/  ── presentation only
     │
hooks/       ── data loading, polling, the shared write pipeline
     │
lib/         ── config · format · errors · stellar · contracts · events · deal
     │
     └────────▶ Soroban RPC + Horizon
```

**`lib/` holds everything that can be reasoned about without React.** That is
where the tests are, and it is deliberate: `format` (stroop maths), `deal` (which
actions to offer), `errors` (what a failure means) and the decoders in
`contracts` are all pure functions.

**`lib/deal.ts` mirrors the contract's guards** to decide which buttons exist.
The contract stays the authority — this only decides what to *offer*, so a stale
page proposes fewer actions rather than producing failing transactions.

**Reads are simulations** against a null source account: no wallet, no fee.
**Writes** run one pipeline — simulate, assemble, sign, submit, poll — reporting
each stage.

**Loading state is derived, never stored.** Results are tagged with the address
they belong to:

```ts
const fresh = loaded && loaded.address === address ? loaded : null;
```

A response for a deal the user has navigated away from is then *structurally
unable* to overwrite what is on screen, and there is no `setState` inside an
effect to cascade renders.

**Endpoints follow the network.** `NEXT_PUBLIC_RPC_URL` and its Horizon
counterpart are optional, and their defaults are selected from
`NEXT_PUBLIC_STELLAR_NETWORK` rather than hardcoded. Hardcoding testnet URLs
would mean a futurenet or mainnet deployment silently reading from testnet — the
configured addresses would resolve to nothing and the app would look broken
rather than misconfigured.

**The root element carries `suppressHydrationWarning`.** StellarWalletsKit writes
its theme variables directly onto the document element as its module evaluates,
giving `<html>` a `style` attribute the server never rendered. The attribute
suppresses diffing one level deep only, so a genuine mismatch anywhere below
still surfaces.

---

## Deployment order

The registry needs the escrow WASM hash and the reputation address to be
constructed. Reputation needs the registry address before it accepts any write.
That is a cycle, and `scripts/deploy.sh` breaks it:

```
1. upload escrow.wasm                        → hash
2. deploy reputation(admin)                  → address        (registry not set)
3. resolve the native SAC address
4. deploy registry(admin, hash, reputation, token)
5. reputation.set_registry(registry)                          ← one-time, closes the loop
6. sync the new addresses across the repo
```

`set_registry` is admin-only and refuses a second call, so the wiring cannot be
changed after the fact.

Step 6 exists because a stale address is a **silent** failure. Six files carry
these addresses: two are generated (`deployments/<network>.json`,
`frontend/.env.local`) and four are written by hand — the committed env example,
both env blocks in the CI workflow, the root README, and the contract reference.
If those four are not updated, nothing breaks: the previously deployed contracts
keep working, so the repo simply documents a deployment that is no longer
current, and no test or build catches it.

`scripts/sync-addresses.mjs` closes that gap with two mechanisms, because the
files differ in kind. Env-style files are rewritten **key-anchored** — the key
names its own value, so no history is needed and it works on a first deploy.
Prose files need **literal replacement**, since an address there sits inside a
table cell, a link href or a badge URL with nothing naming it; `deploy.sh`
snapshots the outgoing record before overwriting it so the old values are known.
The same script runs in CI as `--check`, which fails the build if the repo and
the deployment record disagree.

One thing it cannot reach is a hosting provider's environment. Vercel's
variables live outside the repository, so after a redeploy the registry and
reputation IDs have to be updated there by hand and the site rebuilt — the
network name, passphrase and token address are network constants and never
change.

## Where deployment keys live

The scripts point the Stellar CLI at the project rather than the machine account
by setting `XDG_CONFIG_HOME` to `./.config`, so identities land in
`.config/stellar/identity/<name>.toml`. A checkout therefore carries its own
deployer and nothing is written to a shared home directory. Export the variable
yourself to opt back out.

That file holds the admin's 24-word seed phrase in plaintext. It is gitignored —
`.config/` plus a `**/identity/*.toml` catch-all — but a gitignore only stops
git, not a zip or a synced folder. Whoever holds it can pause the registry,
rotate the admin away, and settle every dispute in every escrow ever deployed,
and there is no recovery path.
