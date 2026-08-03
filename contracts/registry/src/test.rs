#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    Env,
};

const XLM: i128 = 10_000_000;
const WEEK: u64 = 7 * 24 * 60 * 60;

struct Ctx {
    env: Env,
    registry: RegistryContractClient<'static>,
    registry_id: Address,
    admin: Address,
    client: Address,
    worker: Address,
    reputation: Address,
    token: Address,
    escrow_wasm: BytesN<32>,
}

impl Ctx {
    fn deadline(&self) -> u64 {
        self.env.ledger().timestamp() + WEEK
    }

    /// Attempts a deal that differs from the valid baseline in exactly one way
    /// and returns why it was refused, so each test isolates a single rule.
    fn rejection(
        &self,
        worker: &Address,
        title: &str,
        amount: i128,
        milestones: u32,
        deadline: u64,
    ) -> RegistryError {
        self.registry
            .try_create_deal(
                &self.client,
                worker,
                &String::from_str(&self.env, title),
                &amount,
                &milestones,
                &deadline,
            )
            .expect_err("expected the deal to be rejected")
            .expect("expected a typed contract error, not a host failure")
    }
}

fn setup() -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);

    let admin = Address::generate(&env);
    let reputation = Address::generate(&env);
    let token = Address::generate(&env);
    // Validation runs before deployment, so rejection paths never dereference
    // this hash. The real WASM round trip is covered in `integration`.
    let escrow_wasm = BytesN::from_array(&env, &[7u8; 32]);

    let registry_id = env.register(
        RegistryContract,
        (
            admin.clone(),
            escrow_wasm.clone(),
            reputation.clone(),
            token.clone(),
        ),
    );

    Ctx {
        registry: RegistryContractClient::new(&env, &registry_id),
        registry_id,
        admin,
        client: Address::generate(&env),
        worker: Address::generate(&env),
        reputation,
        token,
        escrow_wasm,
        env,
    }
}

// ── Construction and reads ───────────────────────────────────────────────────

#[test]
fn construction_records_the_full_config() {
    let ctx = setup();
    let cfg = ctx.registry.config();

    assert_eq!(cfg.admin, ctx.admin);
    assert_eq!(cfg.escrow_wasm, ctx.escrow_wasm);
    assert_eq!(cfg.reputation, ctx.reputation);
    assert_eq!(cfg.token, ctx.token);
    assert!(!cfg.paused);
    assert_eq!(cfg.total_deals, 0);
}

/// The allowlist backing `is_escrow` must be closed by default — this is the
/// check the reputation contract leans on to reject forged writes.
#[test]
fn an_unknown_address_is_never_treated_as_an_escrow() {
    let ctx = setup();

    assert!(!ctx.registry.is_escrow(&Address::generate(&ctx.env)));
    assert!(!ctx.registry.is_escrow(&ctx.admin));
    assert!(!ctx.registry.is_escrow(&ctx.registry_id));
    assert_eq!(ctx.registry.total_deals(), 0);
}

#[test]
fn paging_within_an_empty_registry_is_empty_but_paging_past_it_is_an_error() {
    let ctx = setup();

    assert_eq!(ctx.registry.get_escrows(&0, &10).len(), 0);
    assert_eq!(
        ctx.registry.try_get_escrows(&1, &10),
        Err(Ok(RegistryError::OutOfRange))
    );
}

// ── Deal validation ──────────────────────────────────────────────────────────

#[test]
fn a_client_cannot_hire_themselves() {
    let ctx = setup();
    let client = ctx.client.clone();

    assert_eq!(
        ctx.rejection(&client, "Self deal", 10 * XLM, 2, ctx.deadline()),
        RegistryError::SelfDeal
    );
}

#[test]
fn dust_deals_are_rejected() {
    let ctx = setup();
    let worker = ctx.worker.clone();

    assert_eq!(
        ctx.rejection(&worker, "Too small", 1, 1, ctx.deadline()),
        RegistryError::InvalidAmount
    );
    assert_eq!(
        ctx.rejection(&worker, "Negative", -5 * XLM, 1, ctx.deadline()),
        RegistryError::InvalidAmount
    );
}

#[test]
fn milestone_counts_must_be_between_one_and_ten() {
    let ctx = setup();
    let worker = ctx.worker.clone();

    assert_eq!(
        ctx.rejection(&worker, "No milestones", 10 * XLM, 0, ctx.deadline()),
        RegistryError::InvalidMilestones
    );
    assert_eq!(
        ctx.rejection(&worker, "Too many", 10 * XLM, 11, ctx.deadline()),
        RegistryError::InvalidMilestones
    );
}

#[test]
fn a_deadline_must_be_in_the_future() {
    let ctx = setup();
    let worker = ctx.worker.clone();
    let now = ctx.env.ledger().timestamp();

    assert_eq!(
        ctx.rejection(&worker, "Yesterday", 10 * XLM, 2, now - 1),
        RegistryError::DeadlineInPast
    );
    // Exactly "now" is also too late — the deal would be refundable instantly.
    assert_eq!(
        ctx.rejection(&worker, "Right now", 10 * XLM, 2, now),
        RegistryError::DeadlineInPast
    );
}

#[test]
fn titles_must_be_present_and_bounded() {
    let ctx = setup();
    let worker = ctx.worker.clone();
    let overlong = "x".repeat((MAX_TITLE_LEN + 1) as usize);

    assert_eq!(
        ctx.rejection(&worker, "", 10 * XLM, 2, ctx.deadline()),
        RegistryError::InvalidTitle
    );
    assert_eq!(
        ctx.rejection(&worker, &overlong, 10 * XLM, 2, ctx.deadline()),
        RegistryError::InvalidTitle
    );
}

// ── Admin surface ────────────────────────────────────────────────────────────

#[test]
fn pausing_blocks_new_deals_and_unpausing_restores_them() {
    let ctx = setup();
    let worker = ctx.worker.clone();

    ctx.registry.set_paused(&true);
    assert!(ctx.registry.is_paused());
    assert_eq!(
        ctx.rejection(&worker, "Blocked", 10 * XLM, 2, ctx.deadline()),
        RegistryError::Paused
    );

    ctx.registry.set_paused(&false);
    assert!(!ctx.registry.is_paused());
    // Past the pause check, validation resumes as normal.
    assert_eq!(
        ctx.rejection(&worker, "", 10 * XLM, 2, ctx.deadline()),
        RegistryError::InvalidTitle
    );
}

#[test]
#[should_panic]
fn a_non_admin_cannot_pause_the_registry() {
    let ctx = setup();

    ctx.env.mock_auths(&[MockAuth {
        address: &ctx.client,
        invoke: &MockAuthInvoke {
            contract: &ctx.registry_id,
            fn_name: "set_paused",
            args: (true,).into_val(&ctx.env),
            sub_invokes: &[],
        },
    }]);
    ctx.registry.set_paused(&true);
}

#[test]
fn admin_rotation_moves_control_to_the_new_address() {
    let ctx = setup();
    let new_admin = Address::generate(&ctx.env);

    ctx.registry.set_admin(&new_admin);

    assert_eq!(ctx.registry.admin(), new_admin);
    assert_eq!(ctx.registry.config().admin, new_admin);

    // The new admin's authorization is now the one that counts.
    ctx.env.mock_auths(&[MockAuth {
        address: &new_admin,
        invoke: &MockAuthInvoke {
            contract: &ctx.registry_id,
            fn_name: "set_paused",
            args: (true,).into_val(&ctx.env),
            sub_invokes: &[],
        },
    }]);
    ctx.registry.set_paused(&true);
    assert!(ctx.registry.is_paused());
}

#[test]
fn the_escrow_implementation_can_be_repointed_for_future_deals() {
    let ctx = setup();
    let next = BytesN::from_array(&ctx.env, &[9u8; 32]);

    ctx.registry.set_escrow_wasm(&next);

    assert_eq!(ctx.registry.config().escrow_wasm, next);
    // Repointing must not disturb anything else about the deployment.
    assert_eq!(ctx.registry.config().reputation, ctx.reputation);
    assert_eq!(ctx.registry.total_deals(), 0);
}
