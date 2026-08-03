/**
 * Derived deal logic, kept out of components so the rules that decide which
 * buttons exist can be reasoned about — and tested — on their own.
 *
 * These mirror the contract's own guards. The contract is still the authority;
 * this only decides what to *offer*, so a stale page proposes fewer actions
 * rather than failing transactions.
 */

import { isPastDeadline } from './format';
import type { Deal, Milestone, Role } from './types';

export function roleFor(deal: Deal, address: string | null): Role {
  if (!address) return 'observer';
  if (address === deal.client) return 'client';
  if (address === deal.worker) return 'worker';
  return 'observer';
}

export interface DealActions {
  canFund: boolean;
  canRefund: boolean;
  canDispute: boolean;
  /** Milestone indices the worker may submit right now. */
  submittable: number[];
  /** Milestone indices the client may approve right now. */
  approvable: number[];
}

export function actionsFor(
  deal: Deal,
  milestones: Milestone[],
  role: Role,
  now = Date.now() / 1000,
): DealActions {
  const active = deal.status === 'active';

  return {
    canFund: role === 'client' && deal.status === 'pending',
    canRefund:
      role === 'client' &&
      active &&
      isPastDeadline(deal.deadline, now) &&
      deal.released < deal.totalAmount,
    canDispute: role !== 'observer' && active,
    submittable:
      active && role === 'worker'
        ? milestones.filter((m) => !m.submitted && !m.approved).map((m) => m.index)
        : [],
    approvable:
      active && role === 'client'
        ? milestones.filter((m) => m.submitted && !m.approved).map((m) => m.index)
        : [],
  };
}

/**
 * What a milestone is worth before it has been approved.
 *
 * Mirrors the contract: milestones split the total evenly and the last one
 * absorbs the integer-division remainder, so the sum is always exactly the
 * deal total and the escrow drains to zero.
 */
export function expectedShare(deal: Deal, index: number): bigint {
  const count = BigInt(deal.milestoneCount);
  if (count === 0n) return 0n;
  const even = deal.totalAmount / count;
  const isFinal = index === deal.milestoneCount - 1;
  return isFinal ? deal.totalAmount - even * (count - 1n) : even;
}

/** The amount to display for a milestone: actual once paid, expected until then. */
export function milestoneAmount(deal: Deal, milestone: Milestone): bigint {
  return milestone.approved ? milestone.amount : expectedShare(deal, milestone.index);
}

/** One line naming what the deal is waiting on, written for the reader's role. */
export function waitingOn(deal: Deal, actions: DealActions, role: Role): string {
  switch (deal.status) {
    case 'pending':
      return role === 'client'
        ? 'Fund the escrow to start the work.'
        : 'Waiting for the client to fund the escrow.';
    case 'active':
      if (actions.approvable.length > 0) return 'Delivered work is waiting on your approval.';
      if (actions.submittable.length > 0) return 'Submit a milestone when the work is ready.';
      return role === 'client'
        ? 'Waiting for the worker to deliver the next milestone.'
        : 'Waiting for the client to review.';
    case 'completed':
      return 'Every milestone was approved and paid.';
    case 'refunded':
      return 'The deadline passed and the unreleased balance went back to the client.';
    case 'disputed':
      return 'Frozen until the registry admin settles it.';
    default:
      return '';
  }
}
