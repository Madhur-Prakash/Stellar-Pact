import { describe, expect, it } from 'vitest';

import { decodeDeal, decodeMilestone, decodeReputation } from './contracts';

const ESCROW = 'CC5BNJ4B5KBZGIBUGWNNSJHYCWBU63UODXUJDVPH2CBSC7FVMSVTZ6XH';
const CLIENT = 'GC5TEJWFS4TA34JLS4EGVW2X2JHYPOKTD7VNW4CFHFPKHRY3TJHGTWFH';
const WORKER = 'GCPCCXJGBEKDMWI5YOJJ7J6N3GFO4IHMXPBP33KQEIMYO3CFLWYWISDP';

/**
 * The shape `scValToNative` hands back for the escrow's `Deal` struct:
 * snake_case keys, bigints for i128/u64, and a plain number for the status
 * enum ordinal. Decoding is the seam where a contract change would break the
 * UI silently, so it is pinned here.
 */
const RAW_DEAL = {
  client: CLIENT,
  worker: WORKER,
  token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  reputation: 'CCTRF56HY5G7HNGQZUUWEKX7OI7NYO55PR3XIU4ZZCCJ3CKUXSZIV3LP',
  registry: 'CDF6NQL6ZDLI5B6WYVVDKR6PTOMCXPQHFHCBS5Y5DWQDFGPL4EMVRK3N',
  title: 'Landing page redesign',
  total_amount: 300_000_000n,
  milestone_count: 2,
  approved_count: 1,
  released: 150_000_000n,
  deadline: 1_700_604_800n,
  status: 1,
  created_at: 1_700_000_000n,
};

describe('decodeDeal', () => {
  it('maps contract fields onto the shape the UI works in', () => {
    const deal = decodeDeal(ESCROW, RAW_DEAL);

    expect(deal.address).toBe(ESCROW);
    expect(deal.client).toBe(CLIENT);
    expect(deal.title).toBe('Landing page redesign');
    expect(deal.totalAmount).toBe(300_000_000n);
    expect(deal.milestoneCount).toBe(2);
    expect(deal.approvedCount).toBe(1);
    expect(deal.released).toBe(150_000_000n);
  });

  it('keeps amounts as bigints rather than lossy numbers', () => {
    const deal = decodeDeal(ESCROW, { ...RAW_DEAL, total_amount: 92_233_720_368_547_758_07n });
    expect(typeof deal.totalAmount).toBe('bigint');
    expect(deal.totalAmount).toBe(9_223_372_036_854_775_807n);
  });

  it('converts u64 timestamps to numbers the date helpers can use', () => {
    const deal = decodeDeal(ESCROW, RAW_DEAL);
    expect(deal.deadline).toBe(1_700_604_800);
    expect(deal.createdAt).toBe(1_700_000_000);
    expect(typeof deal.deadline).toBe('number');
  });

  it('maps every status ordinal to its name, in contract order', () => {
    const expected = ['pending', 'active', 'completed', 'refunded', 'disputed'] as const;
    expected.forEach((name, ordinal) => {
      expect(decodeDeal(ESCROW, { ...RAW_DEAL, status: ordinal }).status).toBe(name);
    });
  });

  it('falls back to pending rather than producing an undefined status', () => {
    expect(decodeDeal(ESCROW, { ...RAW_DEAL, status: 99 }).status).toBe('pending');
  });
});

describe('decodeMilestone', () => {
  it('maps a delivered but unapproved milestone', () => {
    const milestone = decodeMilestone({
      index: 1,
      amount: 0n,
      submitted: true,
      approved: false,
      note: 'Responsive build shipped',
      submitted_at: 1_700_000_500n,
      approved_at: 0n,
    });

    expect(milestone.index).toBe(1);
    expect(milestone.submitted).toBe(true);
    expect(milestone.approved).toBe(false);
    expect(milestone.note).toBe('Responsive build shipped');
    expect(milestone.submittedAt).toBe(1_700_000_500);
  });

  it('renders an empty note as an empty string, never "undefined"', () => {
    const milestone = decodeMilestone({
      index: 0,
      amount: 0n,
      submitted: false,
      approved: false,
      note: undefined,
      submitted_at: 0n,
      approved_at: 0n,
    });
    expect(milestone.note).toBe('');
  });
});

describe('decodeReputation', () => {
  it('maps the worker record', () => {
    const record = decodeReputation({ completed: 2, failed: 1, total_earned: 600_000_000n });

    expect(record.completed).toBe(2);
    expect(record.failed).toBe(1);
    expect(record.totalEarned).toBe(600_000_000n);
    expect(typeof record.totalEarned).toBe('bigint');
  });

  it('maps a worker with no history', () => {
    const record = decodeReputation({ completed: 0, failed: 0, total_earned: 0n });
    expect(record.completed).toBe(0);
    expect(record.totalEarned).toBe(0n);
  });
});
