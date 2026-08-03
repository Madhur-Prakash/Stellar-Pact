#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Env, IntoVal,
};

/// 1 XLM in stroops.
const XLM: i128 = 10_000_000;
const WEEK: u64 = 7 * 24 * 60 * 60;

// ── Test doubles ─────────────────────────────────────────────────────────────
// The escrow only ever talks to its collaborators through their addresses, so
// substituting recorders here lets each cross-contract call be asserted on
// directly. The genuine three-contract wiring is covered in `integration`.

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepCall {
    pub caller: Address,
    pub worker: Address,
    pub amount: i128,
    pub success: bool,
}

#[contract]
pub struct MockReputation;

#[contractimpl]
impl MockReputation {
    pub fn record(env: Env, caller: Address, worker: Address, amount: i128, success: bool) {
        // Mirrors the real contract: proves the escrow authorises as itself.
        caller.require_auth();

        let key = symbol_short!("calls");
        let mut calls: Vec<RepCall> = env
            .storage()
            .instance()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        calls.push_back(RepCall {
            caller,
            worker,
            amount,
            success,
        });
        env.storage().instance().set(&key, &calls);
    }

    pub fn calls(env: Env) -> Vec<RepCall> {
        env.storage()
            .instance()
            .get(&symbol_short!("calls"))
            .unwrap_or_else(|| Vec::new(&env))
    }
}

#[contract]
pub struct MockRegistry;

#[contractimpl]
impl MockRegistry {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage()
            .instance()
            .set(&symbol_short!("admin"), &admin);
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&symbol_short!("admin"))
            .unwrap()
    }
}

// ── Harness ──────────────────────────────────────────────────────────────────

struct Ctx {
    env: Env,
    escrow: EscrowContractClient<'static>,
    escrow_id: Address,
    token: TokenClient<'static>,
    rep: MockReputationClient<'static>,
    client: Address,
    worker: Address,
    admin: Address,
}

impl Ctx {
    fn locked(&self) -> i128 {
        self.token.balance(&self.escrow_id)
    }

    fn advance(&self, secs: u64) {
        self.env.ledger().with_mut(|li| li.timestamp += secs);
    }

    /// Push a milestone all the way through submit → approve.
    fn deliver(&self, index: u32) -> i128 {
        self.escrow
            .submit_milestone(&index, &String::from_str(&self.env, "delivered"));
        self.escrow.approve_milestone(&index)
    }
}

fn setup(total: i128, milestones: u32) -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_700_000_000);

    let issuer = Address::generate(&env);
    let client = Address::generate(&env);
    let worker = Address::generate(&env);
    let admin = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token_id = sac.address();
    StellarAssetClient::new(&env, &token_id).mint(&client, &(100 * XLM));

    let rep_id = env.register(MockReputation, ());
    let registry_id = env.register(MockRegistry, (admin.clone(),));
    let deadline = env.ledger().timestamp() + WEEK;

    let escrow_id = env.register(
        EscrowContract,
        (
            client.clone(),
            worker.clone(),
            token_id.clone(),
            rep_id.clone(),
            registry_id,
            String::from_str(&env, "Landing page redesign"),
            total,
            milestones,
            deadline,
        ),
    );

    Ctx {
        escrow: EscrowContractClient::new(&env, &escrow_id),
        token: TokenClient::new(&env, &token_id),
        rep: MockReputationClient::new(&env, &rep_id),
        escrow_id,
        client,
        worker,
        admin,
        env,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn a_new_deal_starts_pending_and_holds_nothing() {
    let ctx = setup(30 * XLM, 3);
    let deal = ctx.escrow.get_deal();

    assert_eq!(deal.status, Status::Pending);
    assert_eq!(deal.total_amount, 30 * XLM);
    assert_eq!(deal.milestone_count, 3);
    assert_eq!(deal.released, 0);
    assert_eq!(ctx.locked(), 0);
    assert_eq!(ctx.escrow.get_milestones().len(), 3);
}

#[test]
fn funding_moves_the_full_amount_into_the_contract() {
    let ctx = setup(30 * XLM, 3);
    let before = ctx.token.balance(&ctx.client);

    ctx.escrow.fund();

    assert_eq!(ctx.escrow.get_deal().status, Status::Active);
    assert_eq!(ctx.locked(), 30 * XLM);
    assert_eq!(ctx.token.balance(&ctx.client), before - 30 * XLM);
}

/// The headline path: three milestones, three payouts, and a reputation write
/// that the escrow makes on its own behalf.
#[test]
fn completing_every_milestone_pays_the_worker_and_records_reputation() {
    let ctx = setup(30 * XLM, 3);
    ctx.escrow.fund();

    assert_eq!(ctx.deliver(0), 10 * XLM);
    assert_eq!(ctx.token.balance(&ctx.worker), 10 * XLM);
    assert_eq!(ctx.escrow.get_deal().status, Status::Active);
    // Reputation is written once, at completion — not per milestone.
    assert_eq!(ctx.rep.calls().len(), 0);

    ctx.deliver(1);
    ctx.deliver(2);

    let deal = ctx.escrow.get_deal();
    assert_eq!(deal.status, Status::Completed);
    assert_eq!(deal.approved_count, 3);
    assert_eq!(deal.released, 30 * XLM);
    assert_eq!(ctx.token.balance(&ctx.worker), 30 * XLM);
    // The contract must drain to exactly zero.
    assert_eq!(ctx.locked(), 0);

    let calls = ctx.rep.calls();
    assert_eq!(calls.len(), 1);
    let call = calls.get(0).unwrap();
    // The escrow identifies itself, which is what the registry allowlist checks.
    assert_eq!(call.caller, ctx.escrow_id);
    assert_eq!(call.worker, ctx.worker);
    assert_eq!(call.amount, 30 * XLM);
    assert!(call.success);
}

/// Integer division would otherwise strand stroops in the contract forever.
#[test]
fn the_final_milestone_absorbs_the_rounding_remainder() {
    let total = 10_000_003;
    let ctx = setup(total, 3);
    ctx.escrow.fund();

    assert_eq!(ctx.deliver(0), 3_333_334);
    assert_eq!(ctx.deliver(1), 3_333_334);
    assert_eq!(ctx.deliver(2), 3_333_335);

    assert_eq!(ctx.token.balance(&ctx.worker), total);
    assert_eq!(ctx.locked(), 0);
    assert_eq!(ctx.escrow.get_deal().released, total);
}

#[test]
fn funding_twice_is_rejected() {
    let ctx = setup(30 * XLM, 3);
    ctx.escrow.fund();

    assert_eq!(ctx.escrow.try_fund(), Err(Ok(EscrowError::WrongStatus)));
    assert_eq!(ctx.locked(), 30 * XLM);
}

#[test]
fn nothing_can_happen_before_the_deal_is_funded() {
    let ctx = setup(30 * XLM, 3);

    assert_eq!(
        ctx.escrow
            .try_submit_milestone(&0, &String::from_str(&ctx.env, "done")),
        Err(Ok(EscrowError::WrongStatus))
    );
    assert_eq!(
        ctx.escrow.try_approve_milestone(&0),
        Err(Ok(EscrowError::WrongStatus))
    );
}

#[test]
fn a_milestone_cannot_be_approved_before_it_is_submitted() {
    let ctx = setup(30 * XLM, 3);
    ctx.escrow.fund();

    assert_eq!(
        ctx.escrow.try_approve_milestone(&0),
        Err(Ok(EscrowError::NotSubmitted))
    );
    assert_eq!(ctx.token.balance(&ctx.worker), 0);
}

#[test]
fn a_milestone_cannot_be_submitted_or_approved_twice() {
    let ctx = setup(30 * XLM, 3);
    ctx.escrow.fund();
    ctx.escrow
        .submit_milestone(&0, &String::from_str(&ctx.env, "v1"));

    assert_eq!(
        ctx.escrow
            .try_submit_milestone(&0, &String::from_str(&ctx.env, "v2")),
        Err(Ok(EscrowError::AlreadySubmitted))
    );

    ctx.escrow.approve_milestone(&0);
    assert_eq!(
        ctx.escrow.try_approve_milestone(&0),
        Err(Ok(EscrowError::AlreadyApproved))
    );
    assert_eq!(ctx.token.balance(&ctx.worker), 10 * XLM);
}

#[test]
fn out_of_range_milestones_are_rejected() {
    let ctx = setup(30 * XLM, 3);
    ctx.escrow.fund();

    assert_eq!(
        ctx.escrow
            .try_submit_milestone(&7, &String::from_str(&ctx.env, "ghost")),
        Err(Ok(EscrowError::NoSuchMilestone))
    );
    assert_eq!(
        ctx.escrow.try_get_milestone(&7),
        Err(Ok(EscrowError::NoSuchMilestone))
    );
}

#[test]
fn the_client_cannot_refund_before_the_deadline() {
    let ctx = setup(30 * XLM, 3);
    ctx.escrow.fund();

    assert_eq!(
        ctx.escrow.try_refund(),
        Err(Ok(EscrowError::DeadlineNotReached))
    );
    assert_eq!(ctx.locked(), 30 * XLM);
}

/// After the deadline the client recovers only what was never approved — work
/// already paid for stays paid for.
#[test]
fn refunding_after_the_deadline_returns_only_the_unreleased_remainder() {
    let ctx = setup(30 * XLM, 3);
    ctx.escrow.fund();
    ctx.deliver(0);

    let client_before = ctx.token.balance(&ctx.client);
    ctx.advance(WEEK + 1);

    assert_eq!(ctx.escrow.refund(), 20 * XLM);

    assert_eq!(ctx.escrow.get_deal().status, Status::Refunded);
    assert_eq!(ctx.token.balance(&ctx.client), client_before + 20 * XLM);
    assert_eq!(ctx.token.balance(&ctx.worker), 10 * XLM);
    assert_eq!(ctx.locked(), 0);

    let call = ctx.rep.calls().get(0).unwrap();
    assert!(!call.success);
    assert_eq!(call.amount, 0);
}

#[test]
fn only_the_client_or_worker_may_raise_a_dispute() {
    let ctx = setup(30 * XLM, 3);
    ctx.escrow.fund();
    let stranger = Address::generate(&ctx.env);

    assert_eq!(
        ctx.escrow.try_raise_dispute(&stranger),
        Err(Ok(EscrowError::NotAParty))
    );

    ctx.escrow.raise_dispute(&ctx.worker);
    assert_eq!(ctx.escrow.get_deal().status, Status::Disputed);
}

/// The admin is read from the registry at call time rather than stored locally,
/// so this also exercises the escrow → registry hop.
#[test]
fn the_registry_admin_can_settle_a_dispute_in_the_workers_favour() {
    let ctx = setup(30 * XLM, 2);
    ctx.escrow.fund();
    ctx.deliver(0);
    ctx.escrow.raise_dispute(&ctx.worker);

    assert_eq!(ctx.escrow.resolve_dispute(&true), 15 * XLM);

    let deal = ctx.escrow.get_deal();
    assert_eq!(deal.status, Status::Completed);
    assert_eq!(deal.released, 30 * XLM);
    assert_eq!(ctx.token.balance(&ctx.worker), 30 * XLM);
    assert_eq!(ctx.locked(), 0);

    // Reputation is written once, on resolution — the first milestone was not
    // the final one, so it did not trigger a write of its own.
    let calls = ctx.rep.calls();
    assert_eq!(calls.len(), 1);
    assert!(calls.get(0).unwrap().success);
}

#[test]
fn a_dispute_resolved_against_the_worker_returns_the_remainder_to_the_client() {
    let ctx = setup(30 * XLM, 2);
    ctx.escrow.fund();
    ctx.deliver(0);
    let client_before = ctx.token.balance(&ctx.client);
    ctx.escrow.raise_dispute(&ctx.client);

    assert_eq!(ctx.escrow.resolve_dispute(&false), 15 * XLM);

    assert_eq!(ctx.escrow.get_deal().status, Status::Refunded);
    assert_eq!(ctx.token.balance(&ctx.client), client_before + 15 * XLM);
    assert_eq!(ctx.locked(), 0);
    assert!(!ctx.rep.calls().get(0).unwrap().success);
}

/// Authority lives in the registry, not here. With blanket auth mocking turned
/// off, only an explicit authorization from the address the registry names as
/// admin gets the call through.
#[test]
fn only_the_address_the_registry_names_as_admin_can_resolve() {
    let ctx = setup(30 * XLM, 2);
    ctx.escrow.fund();
    ctx.escrow.raise_dispute(&ctx.worker);

    ctx.env.mock_auths(&[MockAuth {
        address: &ctx.admin,
        invoke: &MockAuthInvoke {
            contract: &ctx.escrow_id,
            fn_name: "resolve_dispute",
            args: (true,).into_val(&ctx.env),
            sub_invokes: &[],
        },
    }]);

    assert_eq!(ctx.escrow.resolve_dispute(&true), 30 * XLM);
    assert_eq!(ctx.escrow.get_deal().status, Status::Completed);
}

#[test]
#[should_panic]
fn resolving_without_the_admins_authorization_fails() {
    let ctx = setup(30 * XLM, 2);
    ctx.escrow.fund();
    ctx.escrow.raise_dispute(&ctx.worker);

    // Nothing is authorised from here on.
    ctx.env.mock_auths(&[]);
    ctx.escrow.resolve_dispute(&true);
}

#[test]
fn an_undisputed_deal_cannot_be_resolved() {
    let ctx = setup(30 * XLM, 2);
    ctx.escrow.fund();

    assert_eq!(
        ctx.escrow.try_resolve_dispute(&true),
        Err(Ok(EscrowError::WrongStatus))
    );
}

#[test]
fn a_disputed_deal_freezes_milestone_progress() {
    let ctx = setup(30 * XLM, 3);
    ctx.escrow.fund();
    ctx.escrow.raise_dispute(&ctx.client);

    assert_eq!(
        ctx.escrow
            .try_submit_milestone(&0, &String::from_str(&ctx.env, "late")),
        Err(Ok(EscrowError::WrongStatus))
    );
    assert_eq!(ctx.locked(), 30 * XLM);
}

#[test]
fn oversized_submission_notes_are_rejected() {
    let ctx = setup(30 * XLM, 3);
    ctx.escrow.fund();

    let long = "x".repeat((MAX_NOTE_LEN + 1) as usize);
    assert_eq!(
        ctx.escrow
            .try_submit_milestone(&0, &String::from_str(&ctx.env, &long)),
        Err(Ok(EscrowError::NoteTooLong))
    );
}
