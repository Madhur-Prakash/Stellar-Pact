import { describe, expect, it } from 'vitest';

import { actionsFor, expectedShare, milestoneAmount, roleFor, waitingOn } from './deal';
import type { Deal, DealStatus, Milestone } from './types';

const CLIENT = 'GC5TEJWFS4TA34JLS4EGVW2X2JHYPOKTD7VNW4CFHFPKHRY3TJHGTWFH';
const WORKER = 'GCPCCXJGBEKDMWI5YOJJ7J6N3GFO4IHMXPBP33KQEIMYO3CFLWYWISDP';
const STRANGER = 'GCPJ254TVRU6MG77NM6APNKXYT53ORVNWS3TWYJP6JPIJYGB7ZI3GTOB';
const ESCROW = 'CC5BNJ4B5KBZGIBUGWNNSJHYCWBU63UODXUJDVPH2CBSC7FVMSVTZ6XH';

const NOW = 1_700_000_000;
const XLM = 10_000_000n;

function deal(overrides: Partial<Deal> = {}): Deal {
  return {
    address: ESCROW,
    client: CLIENT,
    worker: WORKER,
    token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    reputation: 'CCTRF56HY5G7HNGQZUUWEKX7OI7NYO55PR3XIU4ZZCCJ3CKUXSZIV3LP',
    registry: 'CDF6NQL6ZDLI5B6WYVVDKR6PTOMCXPQHFHCBS5Y5DWQDFGPL4EMVRK3N',
    title: 'Landing page redesign',
    totalAmount: 30n * XLM,
    milestoneCount: 3,
    approvedCount: 0,
    released: 0n,
    deadline: NOW + 604_800,
    status: 'active',
    createdAt: NOW - 3_600,
    ...overrides,
  };
}

function milestone(index: number, overrides: Partial<Milestone> = {}): Milestone {
  return {
    index,
    amount: 0n,
    submitted: false,
    approved: false,
    note: '',
    submittedAt: 0,
    approvedAt: 0,
    ...overrides,
  };
}

describe('roleFor', () => {
  it('identifies each party', () => {
    expect(roleFor(deal(), CLIENT)).toBe('client');
    expect(roleFor(deal(), WORKER)).toBe('worker');
    expect(roleFor(deal(), STRANGER)).toBe('observer');
  });

  it('treats a disconnected wallet as an observer', () => {
    expect(roleFor(deal(), null)).toBe('observer');
  });
});

describe('actionsFor', () => {
  const three = [milestone(0), milestone(1), milestone(2)];

  it('offers funding only to the client, and only before it is funded', () => {
    const pending = deal({ status: 'pending' });
    expect(actionsFor(pending, three, 'client', NOW).canFund).toBe(true);
    expect(actionsFor(pending, three, 'worker', NOW).canFund).toBe(false);
    expect(actionsFor(deal(), three, 'client', NOW).canFund).toBe(false);
  });

  it('offers submission only to the worker, only for undelivered milestones', () => {
    const milestones = [
      milestone(0, { submitted: true, approved: true }),
      milestone(1, { submitted: true }),
      milestone(2),
    ];
    expect(actionsFor(deal(), milestones, 'worker', NOW).submittable).toEqual([2]);
    expect(actionsFor(deal(), milestones, 'client', NOW).submittable).toEqual([]);
  });

  it('offers approval only to the client, only for delivered milestones', () => {
    const milestones = [
      milestone(0, { submitted: true, approved: true }),
      milestone(1, { submitted: true }),
      milestone(2),
    ];
    expect(actionsFor(deal(), milestones, 'client', NOW).approvable).toEqual([1]);
    expect(actionsFor(deal(), milestones, 'worker', NOW).approvable).toEqual([]);
  });

  /** Mirrors the contract guard: a refund needs the deadline behind you. */
  it('withholds refund until the deadline has elapsed', () => {
    const active = deal({ deadline: NOW + 10 });
    expect(actionsFor(active, three, 'client', NOW).canRefund).toBe(false);
    expect(actionsFor(active, three, 'client', NOW + 11).canRefund).toBe(true);
  });

  it('withholds refund when everything has already been released', () => {
    const drained = deal({ deadline: NOW - 1, released: 30n * XLM, approvedCount: 3 });
    expect(actionsFor(drained, three, 'client', NOW).canRefund).toBe(false);
  });

  it('lets either party dispute but never a stranger', () => {
    expect(actionsFor(deal(), three, 'client', NOW).canDispute).toBe(true);
    expect(actionsFor(deal(), three, 'worker', NOW).canDispute).toBe(true);
    expect(actionsFor(deal(), three, 'observer', NOW).canDispute).toBe(false);
  });

  it('offers nothing once a deal has settled', () => {
    for (const status of ['completed', 'refunded', 'disputed'] as DealStatus[]) {
      const settled = deal({ status, deadline: NOW - 1 });
      const actions = actionsFor(settled, three, 'client', NOW);
      expect(actions.canFund, status).toBe(false);
      expect(actions.canRefund, status).toBe(false);
      expect(actions.approvable, status).toEqual([]);
      expect(actions.submittable, status).toEqual([]);
    }
  });
});

describe('expectedShare', () => {
  it('splits evenly when the total divides cleanly', () => {
    const even = deal({ totalAmount: 30n * XLM, milestoneCount: 3 });
    expect(expectedShare(even, 0)).toBe(10n * XLM);
    expect(expectedShare(even, 1)).toBe(10n * XLM);
    expect(expectedShare(even, 2)).toBe(10n * XLM);
  });

  /**
   * Matches the contract: the last milestone absorbs the integer-division
   * remainder, so the escrow always drains to exactly zero rather than
   * stranding stroops forever.
   */
  it('gives the remainder to the final milestone', () => {
    const awkward = deal({ totalAmount: 10_000_003n, milestoneCount: 3 });
    expect(expectedShare(awkward, 0)).toBe(3_333_334n);
    expect(expectedShare(awkward, 1)).toBe(3_333_334n);
    expect(expectedShare(awkward, 2)).toBe(3_333_335n);
  });

  it('always sums to the exact total, for any split', () => {
    for (const total of [10_000_003n, 1n * XLM, 7n, 999_999_999n, 123_456_789n]) {
      for (let count = 1; count <= 10; count += 1) {
        const subject = deal({ totalAmount: total, milestoneCount: count });
        const sum = Array.from({ length: count }, (_, i) => expectedShare(subject, i)).reduce(
          (a, b) => a + b,
          0n,
        );
        expect(sum, `${total} over ${count}`).toBe(total);
      }
    }
  });

  it('handles a single-milestone deal', () => {
    const one = deal({ totalAmount: 30n * XLM, milestoneCount: 1 });
    expect(expectedShare(one, 0)).toBe(30n * XLM);
  });
});

describe('milestoneAmount', () => {
  it('shows the expected share until approval, then what was actually paid', () => {
    const subject = deal({ totalAmount: 30n * XLM, milestoneCount: 3 });
    expect(milestoneAmount(subject, milestone(0))).toBe(10n * XLM);
    expect(milestoneAmount(subject, milestone(0, { approved: true, amount: 9n * XLM }))).toBe(
      9n * XLM,
    );
  });
});

describe('waitingOn', () => {
  const three = [milestone(0), milestone(1), milestone(2)];

  it('tells each party what is expected of them', () => {
    const pending = deal({ status: 'pending' });
    expect(waitingOn(pending, actionsFor(pending, three, 'client', NOW), 'client')).toMatch(
      /Fund the escrow/,
    );
    expect(waitingOn(pending, actionsFor(pending, three, 'worker', NOW), 'worker')).toMatch(
      /Waiting for the client/,
    );
  });

  it('surfaces a pending approval to the client', () => {
    const milestones = [milestone(0, { submitted: true }), milestone(1), milestone(2)];
    const subject = deal();
    expect(waitingOn(subject, actionsFor(subject, milestones, 'client', NOW), 'client')).toMatch(
      /waiting on your approval/,
    );
  });

  it('has something to say for every status', () => {
    for (const status of [
      'pending',
      'active',
      'completed',
      'refunded',
      'disputed',
    ] as DealStatus[]) {
      const subject = deal({ status });
      const line = waitingOn(subject, actionsFor(subject, three, 'client', NOW), 'client');
      expect(line.length, status).toBeGreaterThan(0);
    }
  });
});
