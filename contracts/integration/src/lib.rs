//! End-to-end tests for the StellarPact contract system.
//!
//! Everything here runs against the *compiled* `.wasm` artifacts rather than
//! native Rust structs, which is the only way to exercise the parts that exist
//! solely at the host boundary: `deploy_v2` called from inside a contract, real
//! contract-to-contract authorization, and the reputation contract's callback
//! into the registry.
//!
//! Build first, then run:
//!
//! ```sh
//! stellar contract build
//! cargo test -p integration
//! ```

#![cfg(test)]
// The escrow's constructor legitimately takes nine arguments, which trips
// clippy inside the generated bindings rather than in code we control.
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

mod registry_contract {
    soroban_sdk::contractimport!(file = "../target/wasm32v1-none/release/registry.wasm");
}
mod escrow_contract {
    soroban_sdk::contractimport!(file = "../target/wasm32v1-none/release/escrow.wasm");
}
mod reputation_contract {
    soroban_sdk::contractimport!(file = "../target/wasm32v1-none/release/reputation.wasm");
}

const XLM: i128 = 10_000_000;
const WEEK: u64 = 7 * 24 * 60 * 60;

struct World {
    env: Env,
    registry: registry_contract::Client<'static>,
    reputation: reputation_contract::Client<'static>,
    token: TokenClient<'static>,
    minter: StellarAssetClient<'static>,
    admin: Address,
}

impl World {
    fn deadline(&self) -> u64 {
        self.env.ledger().timestamp() + WEEK
    }

    /// A funded account, so tests read as "a client with money" rather than a
    /// two-line setup ritual.
    fn account(&self, xlm: i128) -> Address {
        let addr = Address::generate(&self.env);
        self.minter.mint(&addr, &(xlm * XLM));
        addr
    }

    fn escrow_at(&self, addr: &Address) -> escrow_contract::Client<'static> {
        escrow_contract::Client::new(&self.env, addr)
    }

    fn new_deal(
        &self,
        client: &Address,
        worker: &Address,
        title: &str,
        xlm: i128,
        milestones: u32,
    ) -> escrow_contract::Client<'static> {
        let addr = self.registry.create_deal(
            client,
            worker,
            &String::from_str(&self.env, title),
            &(xlm * XLM),
            &milestones,
            &self.deadline(),
        );
        self.escrow_at(&addr)
    }
}

/// Deploys the real system in the real order: reputation, then the registry
/// (which needs the escrow WASM hash), then the one-time wiring that closes the
/// loop between them.
fn deploy_world() -> World {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);

    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token_id = sac.address();

    let reputation_id = env.register(reputation_contract::WASM, (admin.clone(),));

    // The registry stores a WASM *hash*, not an address — it mints escrow
    // instances from this code on demand.
    let escrow_wasm = env.deployer().upload_contract_wasm(escrow_contract::WASM);

    let registry_id = env.register(
        registry_contract::WASM,
        (
            admin.clone(),
            escrow_wasm,
            reputation_id.clone(),
            token_id.clone(),
        ),
    );

    let reputation = reputation_contract::Client::new(&env, &reputation_id);
    reputation.set_registry(&registry_id);

    World {
        registry: registry_contract::Client::new(&env, &registry_id),
        reputation,
        token: TokenClient::new(&env, &token_id),
        minter: StellarAssetClient::new(&env, &token_id),
        admin,
        env,
    }
}

// ─────────────────────────────────────────────────────────────────────────────

/// The flagship path. Every cross-contract hop in the system fires here:
/// registry deploys the escrow, the escrow moves XLM through the SAC twice, and
/// on the final approval it writes reputation — which calls back into the
/// registry to verify the escrow before accepting the write.
#[test]
fn a_deal_created_by_the_registry_settles_end_to_end() {
    let w = deploy_world();
    let client = w.account(100);
    let worker = w.account(0);

    let escrow = w.new_deal(&client, &worker, "Rebuild the checkout flow", 30, 3);

    // The factory really did deploy a new contract and index it.
    assert_eq!(w.registry.total_deals(), 1);
    assert!(w.registry.is_escrow(&escrow.address));
    assert_eq!(w.registry.get_escrows(&0, &10).len(), 1);

    let deal = escrow.get_deal();
    assert_eq!(deal.client, client);
    assert_eq!(deal.worker, worker);
    assert_eq!(deal.total_amount, 30 * XLM);
    assert_eq!(deal.milestone_count, 3);

    escrow.fund();
    assert_eq!(w.token.balance(&escrow.address), 30 * XLM);
    assert_eq!(w.token.balance(&client), 70 * XLM);

    for i in 0..3u32 {
        escrow.submit_milestone(&i, &String::from_str(&w.env, "shipped"));
        escrow.approve_milestone(&i);
    }

    assert_eq!(w.token.balance(&worker), 30 * XLM);
    assert_eq!(w.token.balance(&escrow.address), 0);

    // …and the reputation write landed, having passed the registry check.
    let rep = w.reputation.get(&worker);
    assert_eq!(rep.completed, 1);
    assert_eq!(rep.failed, 0);
    assert_eq!(rep.total_earned, 30 * XLM);
    assert_eq!(w.reputation.score(&worker), 100);
}

/// The security property, proven against real WASM: an escrow that was deployed
/// directly instead of through the factory is byte-identical to a real one and
/// still cannot write reputation — and because the write fails, the payout it
/// was bundled with rolls back too.
#[test]
fn an_escrow_the_registry_never_deployed_cannot_write_reputation() {
    let w = deploy_world();
    let client = w.account(50);
    let worker = w.account(0);

    // Same code, same collaborators — but self-deployed, so not in the index.
    let rogue_id = w.env.register(
        escrow_contract::WASM,
        (
            client.clone(),
            worker.clone(),
            w.token.address.clone(),
            w.reputation.address.clone(),
            w.registry.address.clone(),
            String::from_str(&w.env, "Forged credentials"),
            10 * XLM,
            1u32,
            w.deadline(),
        ),
    );
    let rogue = w.escrow_at(&rogue_id);

    assert!(!w.registry.is_escrow(&rogue_id));

    rogue.fund();
    rogue.submit_milestone(&0, &String::from_str(&w.env, "trust me"));

    // A single-milestone deal settles on first approval, so this approval is
    // the one that tries to touch reputation.
    assert!(rogue.try_approve_milestone(&0).is_err());

    // Nothing was recorded…
    assert_eq!(w.reputation.get(&worker).completed, 0);
    // …and the whole invocation rolled back, so no XLM moved either.
    assert_eq!(w.token.balance(&worker), 0);
    assert_eq!(w.token.balance(&rogue_id), 10 * XLM);
}

/// One contract per deal is the reason funds are safe. Two live deals must not
/// be able to see or spend each other's balance.
#[test]
fn each_deal_gets_its_own_isolated_escrow_and_balance() {
    let w = deploy_world();
    let client = w.account(100);
    let alice = w.account(0);
    let bob = w.account(0);

    let first = w.new_deal(&client, &alice, "Design system", 20, 2);
    let second = w.new_deal(&client, &bob, "API integration", 40, 4);

    assert_ne!(first.address, second.address);
    assert_eq!(w.registry.total_deals(), 2);
    assert_eq!(w.registry.get_escrows(&0, &10).len(), 2);

    first.fund();
    second.fund();
    assert_eq!(w.token.balance(&first.address), 20 * XLM);
    assert_eq!(w.token.balance(&second.address), 40 * XLM);

    // Settling one deal leaves the other untouched.
    first.submit_milestone(&0, &String::from_str(&w.env, "half done"));
    first.approve_milestone(&0);

    assert_eq!(w.token.balance(&alice), 10 * XLM);
    assert_eq!(w.token.balance(&first.address), 10 * XLM);
    assert_eq!(w.token.balance(&bob), 0);
    assert_eq!(w.token.balance(&second.address), 40 * XLM);
}

#[test]
fn reputation_accumulates_across_deals_from_different_escrows() {
    let w = deploy_world();
    let client = w.account(100);
    let worker = w.account(0);

    for (title, amount) in [("First gig", 10i128), ("Second gig", 25i128)] {
        let escrow = w.new_deal(&client, &worker, title, amount, 1);
        escrow.fund();
        escrow.submit_milestone(&0, &String::from_str(&w.env, "done"));
        escrow.approve_milestone(&0);
    }

    let rep = w.reputation.get(&worker);
    assert_eq!(rep.completed, 2);
    assert_eq!(rep.total_earned, 35 * XLM);
    assert_eq!(w.token.balance(&worker), 35 * XLM);
}

/// An abandoned deal must dent the worker's record, not just return the money.
#[test]
fn abandonment_refunds_the_client_and_records_a_failure() {
    let w = deploy_world();
    let client = w.account(100);
    let worker = w.account(0);

    let escrow = w.new_deal(&client, &worker, "Never delivered", 20, 2);
    escrow.fund();
    w.env.ledger().with_mut(|li| li.timestamp += WEEK + 1);

    assert_eq!(escrow.refund(), 20 * XLM);

    assert_eq!(w.token.balance(&client), 100 * XLM);
    assert_eq!(w.token.balance(&escrow.address), 0);

    let rep = w.reputation.get(&worker);
    assert_eq!(rep.completed, 0);
    assert_eq!(rep.failed, 1);
    assert_eq!(w.reputation.score(&worker), 0);
}

/// The circuit breaker must stop new deals without stranding funds already
/// locked in escrows that were created before the pause.
#[test]
fn pausing_the_registry_leaves_live_deals_fully_operational() {
    let w = deploy_world();
    let client = w.account(100);
    let worker = w.account(0);

    let escrow = w.new_deal(&client, &worker, "In flight", 10, 1);
    escrow.fund();

    w.registry.set_paused(&true);
    assert!(w
        .registry
        .try_create_deal(
            &client,
            &worker,
            &String::from_str(&w.env, "Blocked"),
            &(10 * XLM),
            &1,
            &w.deadline(),
        )
        .is_err());

    // The in-flight deal still completes, and still writes reputation.
    escrow.submit_milestone(&0, &String::from_str(&w.env, "delivered"));
    escrow.approve_milestone(&0);

    assert_eq!(w.token.balance(&worker), 10 * XLM);
    assert_eq!(w.reputation.get(&worker).completed, 1);
    assert_eq!(w.registry.total_deals(), 1);
}

/// Escrow addresses are derived from the registry plus a monotonic salt, so the
/// same deal index always yields the same address — deterministic, and never a
/// collision.
#[test]
fn every_deployed_escrow_gets_a_distinct_indexed_address() {
    let w = deploy_world();
    let client = w.account(100);
    let worker = w.account(0);

    let mut seen: Vec<Address> = Vec::new();
    for i in 0..5u32 {
        let escrow = w.new_deal(&client, &worker, "Batch", 10, 1);
        assert!(!seen.contains(&escrow.address), "duplicate escrow address");
        assert!(w.registry.is_escrow(&escrow.address));
        assert_eq!(w.registry.total_deals(), i + 1);
        seen.push(escrow.address.clone());
    }

    let listed = w.registry.get_escrows(&0, &50);
    assert_eq!(listed.len(), 5);
    for addr in listed.iter() {
        assert!(seen.contains(&addr));
    }
}

/// Authority is centralised in the registry: rotating the admin there changes
/// who can settle disputes in every escrow, including ones already deployed.
#[test]
fn rotating_the_registry_admin_changes_who_can_resolve_existing_disputes() {
    let w = deploy_world();
    let client = w.account(100);
    let worker = w.account(0);

    let escrow = w.new_deal(&client, &worker, "Contested work", 20, 2);
    escrow.fund();
    escrow.raise_dispute(&worker);

    let new_admin = Address::generate(&w.env);
    w.registry.set_admin(&new_admin);
    assert_eq!(w.registry.admin(), new_admin);
    assert_ne!(w.registry.admin(), w.admin);

    // The escrow reads the admin from the registry at call time, so the new
    // admin can settle a dispute raised before the rotation happened.
    assert_eq!(escrow.resolve_dispute(&true), 20 * XLM);
    assert_eq!(w.token.balance(&worker), 20 * XLM);
    assert_eq!(w.reputation.get(&worker).completed, 1);
}
