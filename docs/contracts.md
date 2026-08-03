# Contract reference

Every function, argument and error code across the three StellarPact contracts.

Amounts are `i128` **stroops** (1 XLM = 10,000,000 stroops). Timestamps are
`u64` unix seconds.

---

## RegistryContract 

Factory, index, and the single source of admin authority.

Deployed at [`CDF6NQL6ZDLI5B6WYVVDKR6PTOMCXPQHFHCBS5Y5DWQDFGPL4EMVRK3N`](https://stellar.expert/explorer/testnet/contract/CDF6NQL6ZDLI5B6WYVVDKR6PTOMCXPQHFHCBS5Y5DWQDFGPL4EMVRK3N).

### `__constructor(admin, escrow_wasm, reputation, token)`

| Argument | Type | |
|---|---|---|
| `admin` | `Address` | may pause, rotate itself, repoint the escrow WASM, settle disputes |
| `escrow_wasm` | `BytesN<32>` | hash of the escrow implementation to deploy |
| `reputation` | `Address` | reputation contract every escrow will write to |
| `token` | `Address` | asset contract deals settle in (native XLM) |

### `create_deal(client, worker, title, total_amount, milestone_count, deadline) -> Address`

Validates, then deploys a dedicated escrow and returns its address.

| Argument | Type | Constraint |
|---|---|---|
| `client` | `Address` | must authorize; must differ from `worker` |
| `worker` | `Address` | |
| `title` | `String` | 1–128 characters |
| `total_amount` | `i128` | ≥ 10,000 stroops (0.001 XLM) |
| `milestone_count` | `u32` | 1–10 |
| `deadline` | `u64` | strictly in the future |

Emits `DealCreated`. Fails with `Paused` while the circuit breaker is engaged.

### Views

| Function | Returns | |
|---|---|---|
| `is_escrow(addr)` | `bool` | membership check the reputation contract calls on every write |
| `get_escrows(start, limit)` | `Vec<Address>` | paginated, `limit` clamped to 50 |
| `total_deals()` | `u32` | |
| `is_paused()` | `bool` | |
| `admin()` | `Address` | read by every escrow's `resolve_dispute` |
| `config()` | `Config` | admin, wasm hash, reputation, token, paused, total |

### Admin

| Function | Effect |
|---|---|
| `set_paused(paused)` | blocks **new** deals only; escrows already deployed keep working, because funds already locked must never become unreachable |
| `set_escrow_wasm(hash)` | future deals use the new implementation; existing escrows are untouched |
| `set_admin(new_admin)` | takes effect immediately across every escrow ever deployed |

### Errors

| Code | Name | Meaning |
|---|---|---|
| 1 | `NotAuthorized` | caller is not the admin |
| 2 | `Paused` | new deals are disabled |
| 3 | `SelfDeal` | client and worker are the same address |
| 4 | `InvalidAmount` | below the dust floor |
| 5 | `InvalidMilestones` | not between 1 and 10 |
| 6 | `DeadlineInPast` | deadline is at or before now |
| 7 | `InvalidTitle` | empty or over 128 characters |
| 8 | `OutOfRange` | paging start is past the end of the index |

---

## EscrowContract

One instance per deal. Uploaded as WASM hash
`db54dbf7bbb912c7c04a8b22215f01ce811ffa1acc3cc57b37d87255b6249743`; instances are
deployed by the registry.

### `__constructor(client, worker, token, reputation, registry, title, total_amount, milestone_count, deadline)`

Called by the registry through `deploy_v2` in the same transaction as
`create_deal`. Arguments are pre-validated, so this only lays out state and
initialises `milestone_count` empty milestones.

### State machine

```
  Pending ──fund()──▶ Active ──approve × n──▶ Completed
                        │
                        ├── refund()  (after deadline) ──▶ Refunded
                        └── raise_dispute() ──▶ Disputed ──resolve──▶ Completed
                                                                    / Refunded
```

`Status` is a `u32` ordinal on the wire: `0` Pending, `1` Active, `2` Completed,
`3` Refunded, `4` Disputed.

### Actions

| Function | Who | Requires | Does |
|---|---|---|---|
| `fund()` | client | status `Pending` | moves `total_amount` from client into the contract via the SAC → `Active` |
| `submit_milestone(index, note)` | worker | status `Active`, not already submitted, note ≤ 256 chars | marks the milestone delivered |
| `approve_milestone(index) -> i128` | client | status `Active`, milestone submitted, not approved | pays that milestone's share; on the final one, completes the deal **and writes reputation** |
| `refund() -> i128` | client | status `Active`, deadline elapsed, something unreleased | returns `total_amount - released` to the client → `Refunded`, records a failure |
| `raise_dispute(by)` | client or worker | status `Active` | freezes the deal → `Disputed` |
| `resolve_dispute(pay_worker) -> i128` | **registry admin** | status `Disputed` | pays the remainder to one side → `Completed` or `Refunded` |

**Payout maths.** Milestones split the total evenly; the final one is paid as
`total_amount - released`, absorbing the integer-division remainder so the
contract always drains to exactly zero.

```
30 XLM over 3   → 10 + 10 + 10
10_000_003 over 3 → 3_333_334 + 3_333_334 + 3_333_335
```

### Views

| Function | Returns |
|---|---|
| `get_deal()` | `Deal` — parties, amounts, counts, deadline, status |
| `get_milestone(index)` | `Milestone` |
| `get_milestones()` | `Vec<Milestone>` |
| `locked_amount()` | `i128` — stroops still held |

### Errors

| Code | Name | Meaning |
|---|---|---|
| 1 | `WrongStatus` | the deal is not in the state this action needs |
| 2 | `NoSuchMilestone` | index ≥ `milestone_count` |
| 3 | `AlreadySubmitted` | worker submitted this milestone already |
| 4 | `NotSubmitted` | client tried to approve undelivered work |
| 5 | `AlreadyApproved` | milestone already paid |
| 6 | `DeadlineNotReached` | refund attempted too early |
| 7 | `NotAParty` | disputer is neither client nor worker |
| 8 | `NotAuthorized` | |
| 9 | `NoteTooLong` | submission note over 256 characters |
| 10 | `NothingToSettle` | nothing left to move |

---

## ReputationContract

Write-restricted worker record.

Deployed at [`CCTRF56HY5G7HNGQZUUWEKX7OI7NYO55PR3XIU4ZZCCJ3CKUXSZIV3LP`](https://stellar.expert/explorer/testnet/contract/CCTRF56HY5G7HNGQZUUWEKX7OI7NYO55PR3XIU4ZZCCJ3CKUXSZIV3LP).

### `__constructor(admin)`

Deployed before the registry exists, hence the two-step wiring.

### `set_registry(registry)`

Admin-only, **one-time**. Closes the deploy-order cycle between the two
contracts. A second call fails with `AlreadyWired`.

### `record(caller, worker, amount, success)`

The reason this contract exists separately.

```rust
caller.require_auth();
if !RegistryClient::new(&env, &registry).is_escrow(&caller) {
    return Err(ReputationError::NotAnEscrow);
}
```

`caller` is the escrow's own address. Contract-to-contract auth makes
`require_auth` free for a genuine escrow and impossible for anything
impersonating one; the registry lookup then proves the caller was minted by the
factory. An attacker who deploys byte-identical escrow code and runs it to
completion is still refused — and since the write fails, the payout bundled with
it rolls back.

Emits `Recorded`. Failed deals increment `failed` and earn nothing.

### Views

| Function | Returns |
|---|---|
| `get(who)` | `Reputation { completed, failed, total_earned }` — unknown addresses read as empty, not an error |
| `score(who)` | `u32` 0–100 success rate; `0` when there is no history |
| `admin()` | `Address` |
| `registry()` | `Address`, or `RegistryNotSet` |

Unproven and untrustworthy are different things, so the UI shows a worker with no
history as "No completed deals yet" rather than 0%.

### Errors

| Code | Name | Meaning |
|---|---|---|
| 1 | `AlreadyWired` | `set_registry` called twice |
| 2 | `RegistryNotSet` | a write arrived before wiring |
| 3 | `NotAnEscrow` | caller is not an escrow the registry deployed |
| 4 | `InvalidAmount` | negative payout |

---

## Events

All events carry a shared `pact` prefix topic so one RPC filter covers the whole
system, including escrows that do not exist yet.

| Topics | Event | Indexed | Data |
|---|---|---|---|
| `pact, created` | `DealCreated` | escrow, client | worker, title, total_amount, milestone_count, deadline |
| `pact, funded` | `Funded` | client | amount, milestone_count |
| `pact, submitted` | `MilestoneSubmitted` | worker, index | note |
| `pact, approved` | `MilestoneApproved` | worker, index | amount, released |
| `pact, released` | `DealCompleted` | worker | total_amount |
| `pact, refunded` | `DealRefunded` | client | refunded, released |
| `pact, disputed` | `DealDisputed` | by | released, total_amount |
| `pact, resolved` | `DisputeResolved` | recipient | amount, paid_worker |
| `pact, recorded` | `Recorded` | worker, escrow | completed, failed, total_earned, success |
| `pact, wired` | `RegistryWired` | — | registry |
| `pact, paused` | `PauseToggled` | — | paused |
| `pact, wasm` | `EscrowWasmUpdated` | — | escrow_wasm |
| `pact, admin` | `AdminRotated` | new_admin | — |

Soroban caps an event at four topics, which is why each spends two on the prefix
and name and keeps at most two indexed fields.

---

## Calling from the CLI

```sh
# Read the deployment config
stellar contract invoke --network testnet \
  --id CDF6NQL6ZDLI5B6WYVVDKR6PTOMCXPQHFHCBS5Y5DWQDFGPL4EMVRK3N \
  --source-account you -- config

# Create a deal
stellar contract invoke --network testnet \
  --id CDF6NQL6ZDLI5B6WYVVDKR6PTOMCXPQHFHCBS5Y5DWQDFGPL4EMVRK3N \
  --source-account you \
  -- create_deal \
  --client G... --worker G... \
  --title "Landing page redesign" \
  --total_amount 300000000 --milestone_count 2 --deadline 1760000000

# Fund it, then deliver and approve
stellar contract invoke --network testnet --id C...ESCROW --source-account you -- fund
stellar contract invoke --network testnet --id C...ESCROW --source-account worker \
  -- submit_milestone --index 0 --note "Wireframes delivered"
stellar contract invoke --network testnet --id C...ESCROW --source-account you \
  -- approve_milestone --index 0

# Read a worker's record
stellar contract invoke --network testnet \
  --id CCTRF56HY5G7HNGQZUUWEKX7OI7NYO55PR3XIU4ZZCCJ3CKUXSZIV3LP \
  --source-account you -- get --who G...
```

`scripts/demo.sh` runs exactly this sequence and records every transaction hash.
