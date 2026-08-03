#![no_std]
//! # EscrowContract — one deal, one contract
//!
//! Holds a client's XLM and releases it to a worker milestone by milestone.
//! One instance is deployed per deal by the registry, so this contract's entire
//! state describes exactly one agreement and its balance belongs to nobody else.
//!
//! It is the busiest node in the StellarPact call graph — three of the system's
//! four cross-contract hops originate here:
//!
//! ```text
//!   fund()             ──▶ SAC (native XLM)     move value in
//!   approve_milestone()──▶ SAC (native XLM)     pay the worker out
//!                      ──▶ ReputationContract   record the outcome (final one)
//!   resolve_dispute()  ──▶ RegistryContract     ask who the admin is
//! ```
//!
//! ## Lifecycle
//!
//! ```text
//!   Pending ──fund()──▶ Active ──approve × n──▶ Completed
//!                         │
//!                         ├── refund()  (after deadline) ──▶ Refunded
//!                         └── raise_dispute() ──▶ Disputed ──resolve──▶ Completed
//!                                                                     / Refunded
//! ```

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Env, String, Vec,
};

const DAY_LEDGERS: u32 = 17_280;
const STATE_TTL_THRESHOLD: u32 = DAY_LEDGERS * 30;
const STATE_TTL_EXTEND: u32 = DAY_LEDGERS * 90;
const MAX_NOTE_LEN: u32 = 256;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    /// The deal is not in the state this action requires.
    WrongStatus = 1,
    /// Milestone index is >= the deal's milestone count.
    NoSuchMilestone = 2,
    /// Worker tried to submit the same milestone twice.
    AlreadySubmitted = 3,
    /// Client tried to approve a milestone the worker never submitted.
    NotSubmitted = 4,
    AlreadyApproved = 5,
    /// `refund` was called before the deadline elapsed.
    DeadlineNotReached = 6,
    /// Caller is neither the client nor the worker on this deal.
    NotAParty = 7,
    NotAuthorized = 8,
    /// Submission note exceeds the on-chain size cap.
    NoteTooLong = 9,
    /// Nothing left to move — every milestone has already been settled.
    NothingToSettle = 10,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    /// Deployed but the client has not moved the money in yet.
    Pending = 0,
    /// Funded and in progress.
    Active = 1,
    /// Every milestone approved and paid.
    Completed = 2,
    /// Deadline passed with work outstanding; remainder returned to the client.
    Refunded = 3,
    /// Either party escalated; only the registry admin can settle it.
    Disputed = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deal {
    pub client: Address,
    pub worker: Address,
    pub token: Address,
    pub reputation: Address,
    pub registry: Address,
    pub title: String,
    pub total_amount: i128,
    pub milestone_count: u32,
    pub approved_count: u32,
    /// Running total actually paid out, in stroops.
    pub released: i128,
    pub deadline: u64,
    pub status: Status,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    pub index: u32,
    /// Filled in at approval time — the final milestone absorbs the rounding
    /// remainder, so the amount is not known until then.
    pub amount: i128,
    pub submitted: bool,
    pub approved: bool,
    pub note: String,
    pub submitted_at: u64,
    pub approved_at: u64,
}

#[contracttype]
pub enum DataKey {
    Deal,
    Milestone(u32),
}

// ── Events ───────────────────────────────────────────────────────────────────
// The activity feed in the UI is built entirely from these. Each carries enough
// context to render a complete line without a follow-up contract read, which is
// what keeps the feed instant while the deal state is still being refetched.

#[contractevent(topics = ["pact", "funded"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Funded {
    #[topic]
    pub client: Address,
    pub amount: i128,
    pub milestone_count: u32,
}

#[contractevent(topics = ["pact", "submitted"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneSubmitted {
    #[topic]
    pub worker: Address,
    #[topic]
    pub index: u32,
    pub note: String,
}

#[contractevent(topics = ["pact", "approved"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneApproved {
    #[topic]
    pub worker: Address,
    #[topic]
    pub index: u32,
    pub amount: i128,
    pub released: i128,
}

#[contractevent(topics = ["pact", "released"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DealCompleted {
    #[topic]
    pub worker: Address,
    pub total_amount: i128,
}

#[contractevent(topics = ["pact", "refunded"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DealRefunded {
    #[topic]
    pub client: Address,
    pub refunded: i128,
    pub released: i128,
}

#[contractevent(topics = ["pact", "disputed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DealDisputed {
    #[topic]
    pub by: Address,
    pub released: i128,
    pub total_amount: i128,
}

#[contractevent(topics = ["pact", "resolved"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeResolved {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
    pub paid_worker: bool,
}

/// The reputation contract's write surface, as seen from here.
#[contractclient(name = "ReputationClient")]
pub trait ReputationApi {
    fn record(env: Env, caller: Address, worker: Address, amount: i128, success: bool);
}

/// The registry's admin lookup, used only on the dispute path.
#[contractclient(name = "RegistryClient")]
pub trait RegistryApi {
    fn admin(env: Env) -> Address;
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Called by the registry via `deploy_v2` in the same transaction that
    /// creates the deal. Arguments are pre-validated by the registry, so this
    /// only has to lay out state.
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        client: Address,
        worker: Address,
        token: Address,
        reputation: Address,
        registry: Address,
        title: String,
        total_amount: i128,
        milestone_count: u32,
        deadline: u64,
    ) {
        let deal = Deal {
            client,
            worker,
            token,
            reputation,
            registry,
            title,
            total_amount,
            milestone_count,
            approved_count: 0,
            released: 0,
            deadline,
            status: Status::Pending,
            created_at: env.ledger().timestamp(),
        };
        env.storage().instance().set(&DataKey::Deal, &deal);

        for i in 0..milestone_count {
            env.storage().instance().set(
                &DataKey::Milestone(i),
                &Milestone {
                    index: i,
                    amount: 0,
                    submitted: false,
                    approved: false,
                    note: String::from_str(&env, ""),
                    submitted_at: 0,
                    approved_at: 0,
                },
            );
        }
    }

    /// Move the full deal amount from the client into this contract.
    ///
    /// The SAC's own `transfer` requires the client's authorization for the
    /// nested call, which is why the wallet is asked to sign an authorization
    /// tree rather than a flat invocation.
    pub fn fund(env: Env) -> Result<(), EscrowError> {
        let mut deal = Self::get_deal(env.clone());
        deal.client.require_auth();

        if deal.status != Status::Pending {
            return Err(EscrowError::WrongStatus);
        }

        // ── cross-contract hop: escrow → Stellar Asset Contract ─────────────
        let self_address = env.current_contract_address();
        token::TokenClient::new(&env, &deal.token).transfer(
            &deal.client,
            &self_address,
            &deal.total_amount,
        );

        deal.status = Status::Active;
        Self::save_deal(&env, &deal);

        Funded {
            client: deal.client,
            amount: deal.total_amount,
            milestone_count: deal.milestone_count,
        }
        .publish(&env);
        Ok(())
    }

    /// Worker marks a milestone as delivered, attaching a short note that acts
    /// as the on-chain record of what was handed over.
    pub fn submit_milestone(env: Env, index: u32, note: String) -> Result<(), EscrowError> {
        let deal = Self::get_deal(env.clone());
        deal.worker.require_auth();

        if deal.status != Status::Active {
            return Err(EscrowError::WrongStatus);
        }
        if note.len() > MAX_NOTE_LEN {
            return Err(EscrowError::NoteTooLong);
        }

        let mut ms = Self::milestone_or_err(&env, &deal, index)?;
        if ms.approved {
            return Err(EscrowError::AlreadyApproved);
        }
        if ms.submitted {
            return Err(EscrowError::AlreadySubmitted);
        }

        ms.submitted = true;
        ms.note = note.clone();
        ms.submitted_at = env.ledger().timestamp();
        env.storage()
            .instance()
            .set(&DataKey::Milestone(index), &ms);
        Self::bump(&env);

        MilestoneSubmitted {
            worker: deal.worker,
            index,
            note,
        }
        .publish(&env);
        Ok(())
    }

    /// Client approves a submitted milestone, releasing that slice of the funds.
    ///
    /// Returns the amount actually paid. Approving the last milestone also
    /// completes the deal and writes the worker's reputation — the one place
    /// where a two-hop cross-contract call happens.
    pub fn approve_milestone(env: Env, index: u32) -> Result<i128, EscrowError> {
        let mut deal = Self::get_deal(env.clone());
        deal.client.require_auth();

        if deal.status != Status::Active {
            return Err(EscrowError::WrongStatus);
        }

        let mut ms = Self::milestone_or_err(&env, &deal, index)?;
        if ms.approved {
            return Err(EscrowError::AlreadyApproved);
        }
        if !ms.submitted {
            return Err(EscrowError::NotSubmitted);
        }

        let is_final = deal.approved_count + 1 == deal.milestone_count;
        let amount = Self::payout_for(&deal, is_final);

        // ── cross-contract hop: escrow → Stellar Asset Contract ─────────────
        let self_address = env.current_contract_address();
        token::TokenClient::new(&env, &deal.token).transfer(&self_address, &deal.worker, &amount);

        ms.approved = true;
        ms.amount = amount;
        ms.approved_at = env.ledger().timestamp();
        env.storage()
            .instance()
            .set(&DataKey::Milestone(index), &ms);

        deal.approved_count += 1;
        deal.released += amount;

        MilestoneApproved {
            worker: deal.worker.clone(),
            index,
            amount,
            released: deal.released,
        }
        .publish(&env);

        if is_final {
            deal.status = Status::Completed;
            // ── two-hop: escrow → reputation → registry ──────────────────────
            ReputationClient::new(&env, &deal.reputation).record(
                &self_address,
                &deal.worker,
                &deal.total_amount,
                &true,
            );
            DealCompleted {
                worker: deal.worker.clone(),
                total_amount: deal.total_amount,
            }
            .publish(&env);
        }

        Self::save_deal(&env, &deal);
        Ok(amount)
    }

    /// Client reclaims whatever was never approved, once the deadline has passed.
    ///
    /// This is the worker's incentive to deliver and the client's protection
    /// against abandonment. It records a failed deal against the worker only if
    /// they actually left work undone.
    pub fn refund(env: Env) -> Result<i128, EscrowError> {
        let mut deal = Self::get_deal(env.clone());
        deal.client.require_auth();

        if deal.status != Status::Active {
            return Err(EscrowError::WrongStatus);
        }
        if env.ledger().timestamp() <= deal.deadline {
            return Err(EscrowError::DeadlineNotReached);
        }

        let remaining = deal.total_amount - deal.released;
        if remaining <= 0 {
            return Err(EscrowError::NothingToSettle);
        }

        let self_address = env.current_contract_address();
        token::TokenClient::new(&env, &deal.token).transfer(
            &self_address,
            &deal.client,
            &remaining,
        );

        deal.status = Status::Refunded;
        Self::save_deal(&env, &deal);

        ReputationClient::new(&env, &deal.reputation).record(
            &self_address,
            &deal.worker,
            &0,
            &false,
        );

        DealRefunded {
            client: deal.client,
            refunded: remaining,
            released: deal.released,
        }
        .publish(&env);
        Ok(remaining)
    }

    /// Either party can freeze the deal pending arbitration. Freezing is
    /// intentionally cheap and one-sided — the expensive, authorised step is
    /// resolving it.
    pub fn raise_dispute(env: Env, by: Address) -> Result<(), EscrowError> {
        by.require_auth();
        let mut deal = Self::get_deal(env.clone());

        if by != deal.client && by != deal.worker {
            return Err(EscrowError::NotAParty);
        }
        if deal.status != Status::Active {
            return Err(EscrowError::WrongStatus);
        }

        deal.status = Status::Disputed;
        Self::save_deal(&env, &deal);

        DealDisputed {
            by,
            released: deal.released,
            total_amount: deal.total_amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Registry admin settles a frozen deal in one direction or the other.
    ///
    /// The admin identity is not stored here — it is fetched from the registry
    /// at call time, so rotating the admin there takes effect immediately across
    /// every escrow ever deployed.
    pub fn resolve_dispute(env: Env, pay_worker: bool) -> Result<i128, EscrowError> {
        let mut deal = Self::get_deal(env.clone());

        if deal.status != Status::Disputed {
            return Err(EscrowError::WrongStatus);
        }

        // ── cross-contract hop: escrow → registry ───────────────────────────
        let admin = RegistryClient::new(&env, &deal.registry).admin();
        admin.require_auth();

        let remaining = deal.total_amount - deal.released;
        if remaining <= 0 {
            return Err(EscrowError::NothingToSettle);
        }

        let recipient = if pay_worker {
            deal.worker.clone()
        } else {
            deal.client.clone()
        };
        let self_address = env.current_contract_address();
        token::TokenClient::new(&env, &deal.token).transfer(&self_address, &recipient, &remaining);

        if pay_worker {
            deal.released += remaining;
            deal.approved_count = deal.milestone_count;
            deal.status = Status::Completed;
        } else {
            deal.status = Status::Refunded;
        }
        Self::save_deal(&env, &deal);

        ReputationClient::new(&env, &deal.reputation).record(
            &self_address,
            &deal.worker,
            &if pay_worker { deal.total_amount } else { 0 },
            &pay_worker,
        );

        DisputeResolved {
            recipient,
            amount: remaining,
            paid_worker: pay_worker,
        }
        .publish(&env);
        Ok(remaining)
    }

    // ── Views ────────────────────────────────────────────────────────────────

    pub fn get_deal(env: Env) -> Deal {
        env.storage()
            .instance()
            .get(&DataKey::Deal)
            .expect("contract not constructed")
    }

    pub fn get_milestone(env: Env, index: u32) -> Result<Milestone, EscrowError> {
        env.storage()
            .instance()
            .get(&DataKey::Milestone(index))
            .ok_or(EscrowError::NoSuchMilestone)
    }

    pub fn get_milestones(env: Env) -> Vec<Milestone> {
        let deal = Self::get_deal(env.clone());
        let mut out = Vec::new(&env);
        for i in 0..deal.milestone_count {
            if let Some(ms) = env
                .storage()
                .instance()
                .get::<_, Milestone>(&DataKey::Milestone(i))
            {
                out.push_back(ms);
            }
        }
        out
    }

    /// Stroops still held by this contract on behalf of the deal.
    pub fn locked_amount(env: Env) -> i128 {
        let deal = Self::get_deal(env);
        deal.total_amount - deal.released
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /// Milestones split the total evenly, except the last, which takes whatever
    /// integer division left behind so the contract always drains to exactly 0.
    fn payout_for(deal: &Deal, is_final: bool) -> i128 {
        if is_final {
            deal.total_amount - deal.released
        } else {
            deal.total_amount / deal.milestone_count as i128
        }
    }

    fn milestone_or_err(env: &Env, deal: &Deal, index: u32) -> Result<Milestone, EscrowError> {
        if index >= deal.milestone_count {
            return Err(EscrowError::NoSuchMilestone);
        }
        env.storage()
            .instance()
            .get(&DataKey::Milestone(index))
            .ok_or(EscrowError::NoSuchMilestone)
    }

    fn save_deal(env: &Env, deal: &Deal) {
        env.storage().instance().set(&DataKey::Deal, deal);
        Self::bump(env);
    }

    fn bump(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(STATE_TTL_THRESHOLD, STATE_TTL_EXTEND);
    }
}

#[cfg(test)]
mod test;
