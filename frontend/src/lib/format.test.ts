import { describe, expect, it } from 'vitest';

import {
  dateInputToUnix,
  deadlineLabel,
  formatXlm,
  fromStroops,
  isAccountAddress,
  isPastDeadline,
  isValidAddress,
  percentOf,
  relativeTime,
  toStroops,
  truncateAddress,
} from './format';

const ACCOUNT = 'GC5TEJWFS4TA34JLS4EGVW2X2JHYPOKTD7VNW4CFHFPKHRY3TJHGTWFH';
const CONTRACT = 'CDF6NQL6ZDLI5B6WYVVDKR6PTOMCXPQHFHCBS5Y5DWQDFGPL4EMVRK3N';

describe('toStroops', () => {
  it('converts whole and fractional XLM to stroops', () => {
    expect(toStroops('30')).toBe(300_000_000n);
    expect(toStroops('1.5')).toBe(15_000_000n);
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops('0')).toBe(0n);
  });

  it('tolerates surrounding whitespace', () => {
    expect(toStroops('  30.25  ')).toBe(302_500_000n);
  });

  /**
   * The important one: an eighth decimal place cannot be represented on-chain.
   * Rounding it would move an amount the user never agreed to, so the input is
   * refused instead.
   */
  it('rejects more precision than a stroop can hold', () => {
    expect(() => toStroops('1.12345678')).toThrow();
  });

  it('rejects anything that is not a positive decimal', () => {
    for (const bad of ['', '-1', 'abc', '1e5', '1.', '.5', '1,5', '1 2']) {
      expect(() => toStroops(bad), `expected "${bad}" to be rejected`).toThrow();
    }
  });

  it('keeps full precision on amounts far past Number.MAX_SAFE_INTEGER', () => {
    expect(toStroops('92233720368.5477580')).toBe(922_337_203_685_477_580n);
  });
});

describe('fromStroops', () => {
  it('trims trailing zeros but keeps significant decimals', () => {
    expect(fromStroops(300_000_000n)).toBe('30');
    expect(fromStroops(15_000_000n)).toBe('1.5');
    expect(fromStroops(1n)).toBe('0.0000001');
    expect(fromStroops(0n)).toBe('0');
  });

  it('handles negative amounts', () => {
    expect(fromStroops(-15_000_000n)).toBe('-1.5');
  });

  it('round-trips with toStroops', () => {
    for (const value of ['0', '1', '30.25', '0.0000001', '123456.789']) {
      expect(fromStroops(toStroops(value))).toBe(fromStroops(toStroops(value)));
      expect(toStroops(fromStroops(toStroops(value)))).toBe(toStroops(value));
    }
  });
});

describe('formatXlm', () => {
  it('groups thousands', () => {
    expect(formatXlm(12_345_678_900_000n)).toBe('1,234,567.89');
    expect(formatXlm(300_000_000n)).toBe('30');
  });

  it('truncates to the requested precision without rounding up', () => {
    expect(formatXlm(19_999_999n, 2)).toBe('1.99');
    expect(formatXlm(19_999_999n)).toBe('1.9999999');
  });

  it('drops the decimal point when nothing survives truncation', () => {
    expect(formatXlm(10_000_001n, 2)).toBe('1');
  });
});

describe('percentOf', () => {
  it('reports the share of the total', () => {
    expect(percentOf(15n, 30n)).toBe(50);
    expect(percentOf(30n, 30n)).toBe(100);
    expect(percentOf(1n, 3n)).toBeCloseTo(33.33, 1);
  });

  it('treats an empty total as zero rather than dividing by it', () => {
    expect(percentOf(5n, 0n)).toBe(0);
  });

  it('clamps out-of-range inputs', () => {
    expect(percentOf(40n, 30n)).toBe(100);
    expect(percentOf(-5n, 30n)).toBe(0);
  });
});

describe('address helpers', () => {
  it('truncates long addresses and leaves short strings alone', () => {
    expect(truncateAddress(ACCOUNT)).toBe('GC5T…TWFH');
    expect(truncateAddress('GABC')).toBe('GABC');
    expect(truncateAddress(ACCOUNT, 6, 6)).toBe('GC5TEJ…HGTWFH');
  });

  it('accepts real account and contract addresses', () => {
    expect(isValidAddress(ACCOUNT)).toBe(true);
    expect(isValidAddress(CONTRACT)).toBe(true);
    expect(isValidAddress(` ${ACCOUNT} `)).toBe(true);
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['', 'not-an-address', 'G123', `${ACCOUNT}X`]) {
      expect(isValidAddress(bad), `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  /** Workers must be accounts — a contract cannot hold a Stellar payout here. */
  it('distinguishes accounts from contracts', () => {
    expect(isAccountAddress(ACCOUNT)).toBe(true);
    expect(isAccountAddress(CONTRACT)).toBe(false);
  });
});

describe('time helpers', () => {
  const now = 1_700_000_000;

  it('describes how long ago something happened', () => {
    expect(relativeTime(now, now)).toBe('just now');
    expect(relativeTime(now - 300, now)).toBe('5m ago');
    expect(relativeTime(now - 7_200, now)).toBe('2h ago');
    expect(relativeTime(now - 259_200, now)).toBe('3d ago');
  });

  it('counts down to a deadline', () => {
    expect(deadlineLabel(now + 604_800, now)).toBe('7d left');
    expect(deadlineLabel(now + 7_200, now)).toBe('2h left');
    expect(deadlineLabel(now + 120, now)).toBe('2m left');
  });

  /** Past the deadline the client may refund, so the copy says that outcome. */
  it('states the outcome rather than a negative duration once elapsed', () => {
    expect(deadlineLabel(now - 1, now)).toBe('Deadline passed');
    expect(deadlineLabel(now, now)).toBe('Deadline passed');
    expect(isPastDeadline(now, now)).toBe(true);
    expect(isPastDeadline(now + 1, now)).toBe(false);
  });

  it('reads a date input as the end of that day in UTC', () => {
    expect(dateInputToUnix('2026-08-09')).toBe(
      Math.floor(Date.parse('2026-08-09T23:59:59Z') / 1000),
    );
  });
});
