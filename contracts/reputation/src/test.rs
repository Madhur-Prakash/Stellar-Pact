#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Env};

/// A stand-in for the registry that answers `is_escrow` from an explicit
/// allowlist. Using a mock here keeps this crate's tests free of any dependency
/// on compiled WASM — the real registry↔reputation↔escrow round trip is covered
/// end-to-end in the `integration` crate.
#[contracttype]
pub enum MockKey {
    Allowed(Address),
}

#[contract]
pub struct MockRegistry;

#[contractimpl]
impl MockRegistry {
    pub fn allow(env: Env, addr: Address) {
        env.storage()
            .persistent()
            .set(&MockKey::Allowed(addr), &true);
    }

    pub fn is_escrow(env: Env, addr: Address) -> bool {
        env.storage()
            .persistent()
            .get(&MockKey::Allowed(addr))
            .unwrap_or(false)
    }
}

struct Harness {
    env: Env,
    rep: ReputationContractClient<'static>,
    registry: MockRegistryClient<'static>,
    worker: Address,
    escrow: Address,
}

/// Deploys reputation + a mock registry and wires them together, mirroring the
/// real two-step deployment order.
fn setup() -> Harness {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let rep_id = env.register(ReputationContract, (admin.clone(),));
    let registry_id = env.register(MockRegistry, ());

    let rep = ReputationContractClient::new(&env, &rep_id);
    let registry = MockRegistryClient::new(&env, &registry_id);
    rep.set_registry(&registry_id);

    // A believable escrow: a real contract address, allowlisted in the registry.
    let escrow = env.register(MockRegistry, ());
    registry.allow(&escrow);

    let worker = Address::generate(&env);

    Harness {
        env,
        rep,
        registry,
        worker,
        escrow,
    }
}

#[test]
fn records_a_successful_deal() {
    let h = setup();

    h.rep.record(&h.escrow, &h.worker, &50_000_000, &true);

    let rep = h.rep.get(&h.worker);
    assert_eq!(rep.completed, 1);
    assert_eq!(rep.failed, 0);
    assert_eq!(rep.total_earned, 50_000_000);
    assert_eq!(h.rep.score(&h.worker), 100);
}

#[test]
fn score_is_a_success_rate_and_failures_do_not_earn() {
    let h = setup();

    h.rep.record(&h.escrow, &h.worker, &10_000_000, &true);
    h.rep.record(&h.escrow, &h.worker, &10_000_000, &true);
    h.rep.record(&h.escrow, &h.worker, &10_000_000, &true);
    h.rep.record(&h.escrow, &h.worker, &0, &false);

    let rep = h.rep.get(&h.worker);
    assert_eq!(rep.completed, 3);
    assert_eq!(rep.failed, 1);
    // A failed deal must not inflate lifetime earnings.
    assert_eq!(rep.total_earned, 30_000_000);
    assert_eq!(h.rep.score(&h.worker), 75);
}

#[test]
fn unknown_worker_reads_as_empty_rather_than_erroring() {
    let h = setup();
    let stranger = Address::generate(&h.env);

    let rep = h.rep.get(&stranger);
    assert_eq!(rep.completed, 0);
    assert_eq!(rep.failed, 0);
    assert_eq!(rep.total_earned, 0);
    assert_eq!(h.rep.score(&stranger), 0);
}

/// The security property this contract exists for: an address the registry
/// never deployed cannot write its own reputation, even with valid auth.
#[test]
fn rejects_writes_from_an_address_the_registry_does_not_know() {
    let h = setup();
    let impostor = Address::generate(&h.env);

    assert_eq!(
        h.rep.try_record(&impostor, &h.worker, &99_000_000, &true),
        Err(Ok(ReputationError::NotAnEscrow))
    );
    assert_eq!(h.rep.get(&h.worker).completed, 0);
}

#[test]
fn rejects_writes_before_the_registry_is_wired() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let rep = ReputationContractClient::new(&env, &env.register(ReputationContract, (admin,)));
    let worker = Address::generate(&env);
    let escrow = Address::generate(&env);

    assert_eq!(
        rep.try_record(&escrow, &worker, &1_000, &true),
        Err(Ok(ReputationError::RegistryNotSet))
    );
    assert_eq!(rep.try_registry(), Err(Ok(ReputationError::RegistryNotSet)));
}

#[test]
fn registry_wiring_is_one_time_only() {
    let h = setup();
    let other = Address::generate(&h.env);

    assert_eq!(
        h.rep.try_set_registry(&other),
        Err(Ok(ReputationError::AlreadyWired))
    );
    assert_eq!(h.rep.registry(), h.registry.address);
}

#[test]
fn rejects_negative_payout_amounts() {
    let h = setup();

    assert_eq!(
        h.rep.try_record(&h.escrow, &h.worker, &-1, &true),
        Err(Ok(ReputationError::InvalidAmount))
    );
}

#[test]
fn reputation_accumulates_across_separate_escrows() {
    let h = setup();
    let second_escrow = h.env.register(MockRegistry, ());
    h.registry.allow(&second_escrow);

    h.rep.record(&h.escrow, &h.worker, &20_000_000, &true);
    h.rep.record(&second_escrow, &h.worker, &5_000_000, &true);

    assert_eq!(h.rep.get(&h.worker).total_earned, 25_000_000);
    assert_eq!(h.rep.get(&h.worker).completed, 2);
}
