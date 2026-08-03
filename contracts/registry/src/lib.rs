#![no_std]
//! # RegistryContract — the StellarPact factory
//!
//! Every deal in StellarPact gets its own escrow contract instance rather than a
//! row in a shared table. That isolation is what makes the money safe: a bug or
//! a dispute in one deal cannot touch another deal's balance, and each escrow's
//! address *is* the deal's identity on-chain.
//!
//! To make that practical, this contract deploys those instances itself using
//! `env.deployer()` — a contract deploying another contract, with constructor
//! arguments, in the same transaction the client signs.
//!
//! ```text
//!   client ──create_deal()──▶ RegistryContract ──deploy_v2()──▶ EscrowContract #n
//! ```
//!
//! It also doubles as the source of truth for "is this address a real escrow?",
//! which the reputation contract calls back into before accepting any write.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, vec, Address, BytesN, Env,
    IntoVal, String, Val, Vec,
};

const DAY_LEDGERS: u32 = 17_280;
const INDEX_TTL_THRESHOLD: u32 = DAY_LEDGERS * 30;
const INDEX_TTL_EXTEND: u32 = DAY_LEDGERS * 90;

/// Ten is a product decision, not a technical one: past that, a deal should be
/// split into several deals so each has its own deadline and its own escrow.
const MAX_MILESTONES: u32 = 10;
const MAX_TITLE_LEN: u32 = 128;
/// Guards against fat-fingered dust deals — 0.001 XLM in stroops. Comfortably
/// above `MAX_MILESTONES`, which also guarantees that the per-milestone share
/// never rounds down to zero stroops.
const MIN_DEAL_AMOUNT: i128 = 10_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    NotAuthorized = 1,
    /// The admin circuit breaker is engaged; no new deals may be created.
    Paused = 2,
    /// Client and worker are the same address.
    SelfDeal = 3,
    InvalidAmount = 4,
    InvalidMilestones = 5,
    /// Deadline is at or before the current ledger timestamp.
    DeadlineInPast = 6,
    InvalidTitle = 7,
    OutOfRange = 8,
}

/// Deployment-wide configuration, read by the frontend on boot so that no
/// contract address is ever hardcoded in two places.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    /// WASM hash of the escrow contract that `create_deal` instantiates.
    pub escrow_wasm: BytesN<32>,
    pub reputation: Address,
    /// The Stellar Asset Contract escrows move value with (native XLM).
    pub token: Address,
    pub paused: bool,
    pub total_deals: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    EscrowWasm,
    Reputation,
    Token,
    Paused,
    Count,
    /// Dense index → escrow address, for pagination.
    Escrow(u32),
    /// Membership set used by `is_escrow`.
    IsEscrow(Address),
}

// ── Events ───────────────────────────────────────────────────────────────────
// Soroban caps an event at four topics, so each event spends two on the shared
// `pact` prefix plus its own name and keeps at most two indexed addresses. The
// rest of the payload lives in the data section.

#[contractevent(topics = ["pact", "created"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DealCreated {
    #[topic]
    pub escrow: Address,
    #[topic]
    pub client: Address,
    pub worker: Address,
    pub title: String,
    pub total_amount: i128,
    pub milestone_count: u32,
    pub deadline: u64,
}

#[contractevent(topics = ["pact", "paused"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseToggled {
    pub paused: bool,
}

#[contractevent(topics = ["pact", "wasm"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowWasmUpdated {
    pub escrow_wasm: BytesN<32>,
}

#[contractevent(topics = ["pact", "admin"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminRotated {
    #[topic]
    pub new_admin: Address,
}

#[contract]
pub struct RegistryContract;

#[contractimpl]
impl RegistryContract {
    pub fn __constructor(
        env: Env,
        admin: Address,
        escrow_wasm: BytesN<32>,
        reputation: Address,
        token: Address,
    ) {
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::EscrowWasm, &escrow_wasm);
        storage.set(&DataKey::Reputation, &reputation);
        storage.set(&DataKey::Token, &token);
        storage.set(&DataKey::Paused, &false);
        storage.set(&DataKey::Count, &0u32);
    }

    /// Create a deal: validate, then deploy a dedicated escrow contract for it.
    ///
    /// The escrow is deployed with constructor arguments, so it is fully
    /// initialised the moment it exists — there is no window in which a
    /// half-configured escrow is callable by anyone.
    pub fn create_deal(
        env: Env,
        client: Address,
        worker: Address,
        title: String,
        total_amount: i128,
        milestone_count: u32,
        deadline: u64,
    ) -> Result<Address, RegistryError> {
        client.require_auth();

        if Self::is_paused(env.clone()) {
            return Err(RegistryError::Paused);
        }
        if client == worker {
            return Err(RegistryError::SelfDeal);
        }
        if total_amount < MIN_DEAL_AMOUNT {
            return Err(RegistryError::InvalidAmount);
        }
        if milestone_count == 0 || milestone_count > MAX_MILESTONES {
            return Err(RegistryError::InvalidMilestones);
        }
        if deadline <= env.ledger().timestamp() {
            return Err(RegistryError::DeadlineInPast);
        }
        if title.is_empty() || title.len() > MAX_TITLE_LEN {
            return Err(RegistryError::InvalidTitle);
        }
        let index: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let escrow_wasm: BytesN<32> = env.storage().instance().get(&DataKey::EscrowWasm).unwrap();
        let reputation: Address = env.storage().instance().get(&DataKey::Reputation).unwrap();
        let token: Address = env.storage().instance().get(&DataKey::Token).unwrap();

        let args: Vec<Val> = vec![
            &env,
            client.to_val(),
            worker.to_val(),
            token.to_val(),
            reputation.to_val(),
            env.current_contract_address().to_val(),
            title.to_val(),
            total_amount.into_val(&env),
            milestone_count.into_val(&env),
            deadline.into_val(&env),
        ];

        // ── cross-contract deploy: registry → new escrow instance ───────────
        let escrow = env
            .deployer()
            .with_current_contract(Self::salt_for(&env, index))
            .deploy_v2(escrow_wasm, args);

        env.storage().instance().set(&DataKey::Count, &(index + 1));
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(index), &escrow);
        env.storage()
            .persistent()
            .set(&DataKey::IsEscrow(escrow.clone()), &true);
        Self::bump_index(&env, index, &escrow);

        DealCreated {
            escrow: escrow.clone(),
            client,
            worker,
            title,
            total_amount,
            milestone_count,
            deadline,
        }
        .publish(&env);

        Ok(escrow)
    }

    /// Membership check used by the reputation contract to reject forged writes.
    /// Deliberately the cheapest call on this contract — it sits in the hot path
    /// of every deal completion.
    pub fn is_escrow(env: Env, addr: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::IsEscrow(addr))
            .unwrap_or(false)
    }

    /// Paginated escrow list, newest-last. `limit` is clamped to 50 so a caller
    /// cannot blow the resource budget by asking for everything at once.
    pub fn get_escrows(env: Env, start: u32, limit: u32) -> Result<Vec<Address>, RegistryError> {
        let count = Self::total_deals(env.clone());
        if start > count {
            return Err(RegistryError::OutOfRange);
        }
        let capped = if limit > 50 { 50 } else { limit };
        let end = core::cmp::min(start.saturating_add(capped), count);

        let mut out = Vec::new(&env);
        for i in start..end {
            if let Some(addr) = env
                .storage()
                .persistent()
                .get::<_, Address>(&DataKey::Escrow(i))
            {
                out.push_back(addr);
            }
        }
        Ok(out)
    }

    pub fn total_deals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not constructed")
    }

    pub fn config(env: Env) -> Config {
        let storage = env.storage().instance();
        Config {
            admin: storage.get(&DataKey::Admin).unwrap(),
            escrow_wasm: storage.get(&DataKey::EscrowWasm).unwrap(),
            reputation: storage.get(&DataKey::Reputation).unwrap(),
            token: storage.get(&DataKey::Token).unwrap(),
            paused: storage.get(&DataKey::Paused).unwrap_or(false),
            total_deals: storage.get(&DataKey::Count).unwrap_or(0),
        }
    }

    // ── Admin surface ────────────────────────────────────────────────────────

    /// Circuit breaker. Only blocks *new* deals — escrows already deployed keep
    /// working, because funds already locked must never become unreachable.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), RegistryError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        PauseToggled { paused }.publish(&env);
        Ok(())
    }

    /// Point the factory at a new escrow implementation. Existing escrows are
    /// untouched; only subsequent deals use the new code.
    pub fn set_escrow_wasm(env: Env, escrow_wasm: BytesN<32>) -> Result<(), RegistryError> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::EscrowWasm, &escrow_wasm);
        EscrowWasmUpdated { escrow_wasm }.publish(&env);
        Ok(())
    }

    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), RegistryError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        AdminRotated { new_admin }.publish(&env);
        Ok(())
    }

    // ── Internals ────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), RegistryError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RegistryError::NotAuthorized)?;
        admin.require_auth();
        Ok(())
    }

    /// The salt only has to be unique *within this registry* — `deploy_v2`
    /// already namespaces addresses by the deploying contract — so a monotonic
    /// deal index is sufficient and keeps escrow addresses reproducible.
    fn salt_for(env: &Env, index: u32) -> BytesN<32> {
        let mut salt = [0u8; 32];
        salt[28] = (index >> 24) as u8;
        salt[29] = (index >> 16) as u8;
        salt[30] = (index >> 8) as u8;
        salt[31] = index as u8;
        BytesN::from_array(env, &salt)
    }

    fn bump_index(env: &Env, index: u32, escrow: &Address) {
        env.storage().persistent().extend_ttl(
            &DataKey::Escrow(index),
            INDEX_TTL_THRESHOLD,
            INDEX_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::IsEscrow(escrow.clone()),
            INDEX_TTL_THRESHOLD,
            INDEX_TTL_EXTEND,
        );
    }
}

#[cfg(test)]
mod test;
