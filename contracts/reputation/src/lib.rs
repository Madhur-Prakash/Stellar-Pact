#![no_std]
//! # ReputationContract
//!
//! A write-restricted, append-only reputation ledger for StellarPact workers.
//!
//! The interesting property of this contract is *who is allowed to write to it*.
//! Reputation is only valuable if it cannot be forged, so `record` refuses every
//! caller except an escrow contract that the StellarPact registry actually
//! deployed. Verifying that requires a **cross-contract call back into the
//! registry** — this contract never trusts the caller's own claim about itself.
//!
//! ```text
//!   EscrowContract ──record()──▶ ReputationContract ──is_escrow()──▶ RegistryContract
//! ```

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, Address,
    Env,
};

// ── Storage lifetime tuning ──────────────────────────────────────────────────
// Reputation is long-lived data: a worker's history should outlive any single
// deal, so entries are bumped generously whenever they are touched.
const DAY_LEDGERS: u32 = 17_280;
const SCORE_TTL_THRESHOLD: u32 = DAY_LEDGERS * 30;
const SCORE_TTL_EXTEND: u32 = DAY_LEDGERS * 90;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ReputationError {
    /// `set_registry` has already been called; the wiring is one-time.
    AlreadyWired = 1,
    /// `record` was called before the registry address was configured.
    RegistryNotSet = 2,
    /// The caller is not an escrow deployed by the registry.
    NotAnEscrow = 3,
    /// Negative payout amounts are meaningless.
    InvalidAmount = 4,
}

/// A worker's lifetime record. Deliberately small — every field is derivable
/// on-chain and cheap to read from the frontend.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reputation {
    pub completed: u32,
    pub failed: u32,
    pub total_earned: i128,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Registry,
    Score(Address),
}

// ── Events ───────────────────────────────────────────────────────────────────
// Every StellarPact event across all three contracts shares the `pact` prefix
// topic, so the frontend can subscribe to the whole system with one RPC filter
// and still switch on the second topic to decide how to render each entry.

#[contractevent(topics = ["pact", "recorded"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Recorded {
    #[topic]
    pub worker: Address,
    #[topic]
    pub escrow: Address,
    pub completed: u32,
    pub failed: u32,
    pub total_earned: i128,
    pub success: bool,
}

#[contractevent(topics = ["pact", "wired"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistryWired {
    pub registry: Address,
}

/// The slice of the registry's interface this contract depends on.
///
/// Declaring it as a client trait rather than importing the registry crate
/// keeps the dependency graph acyclic: the registry deploys escrows, escrows
/// call reputation, and reputation calls back here — by address, at runtime.
#[contractclient(name = "RegistryClient")]
pub trait RegistryVerifier {
    fn is_escrow(env: Env, addr: Address) -> bool;
}

#[contract]
pub struct ReputationContract;

#[contractimpl]
impl ReputationContract {
    /// Deployed first, before the registry exists — hence the two-step wiring.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// One-time wiring performed by the admin immediately after the registry is
    /// deployed. This breaks the deploy-order cycle between the two contracts:
    /// the registry needs to exist before its address can be recorded here.
    pub fn set_registry(env: Env, registry: Address) -> Result<(), ReputationError> {
        Self::admin(env.clone()).require_auth();
        if env.storage().instance().has(&DataKey::Registry) {
            return Err(ReputationError::AlreadyWired);
        }
        env.storage().instance().set(&DataKey::Registry, &registry);
        RegistryWired { registry }.publish(&env);
        Ok(())
    }

    /// Record the outcome of a completed or defaulted deal.
    ///
    /// `caller` is the escrow contract's own address. Contract-to-contract auth
    /// makes `require_auth` here free for a genuine escrow and impossible to
    /// satisfy for anyone impersonating one, and the registry lookup then proves
    /// the caller was minted by the factory rather than deployed independently.
    pub fn record(
        env: Env,
        caller: Address,
        worker: Address,
        amount: i128,
        success: bool,
    ) -> Result<(), ReputationError> {
        caller.require_auth();

        if amount < 0 {
            return Err(ReputationError::InvalidAmount);
        }

        let registry: Address = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(ReputationError::RegistryNotSet)?;

        // ── cross-contract hop: reputation → registry ───────────────────────
        if !RegistryClient::new(&env, &registry).is_escrow(&caller) {
            return Err(ReputationError::NotAnEscrow);
        }

        let mut rep = Self::get(env.clone(), worker.clone());
        if success {
            rep.completed += 1;
            rep.total_earned += amount;
        } else {
            rep.failed += 1;
        }

        let key = DataKey::Score(worker.clone());
        env.storage().persistent().set(&key, &rep);
        env.storage()
            .persistent()
            .extend_ttl(&key, SCORE_TTL_THRESHOLD, SCORE_TTL_EXTEND);

        Recorded {
            worker,
            escrow: caller,
            completed: rep.completed,
            failed: rep.failed,
            total_earned: rep.total_earned,
            success,
        }
        .publish(&env);
        Ok(())
    }

    /// Full record for a worker. Unknown addresses read as an empty history
    /// rather than an error, so the frontend can render new workers uniformly.
    pub fn get(env: Env, who: Address) -> Reputation {
        env.storage()
            .persistent()
            .get(&DataKey::Score(who))
            .unwrap_or(Reputation {
                completed: 0,
                failed: 0,
                total_earned: 0,
            })
    }

    /// Success rate as a 0–100 integer. Returns 0 for workers with no history —
    /// unproven and untrustworthy are shown differently in the UI.
    pub fn score(env: Env, who: Address) -> u32 {
        let rep = Self::get(env, who);
        let total = rep.completed + rep.failed;
        if total == 0 {
            return 0;
        }
        (rep.completed * 100) / total
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not constructed")
    }

    pub fn registry(env: Env) -> Result<Address, ReputationError> {
        env.storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(ReputationError::RegistryNotSet)
    }
}

#[cfg(test)]
mod test;
