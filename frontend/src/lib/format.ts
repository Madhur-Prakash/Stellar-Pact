/**
 * Value formatting. XLM is an integer number of stroops on-chain and must stay
 * that way in JS too — every amount here is a bigint, and no intermediate step
 * is ever allowed to become a float.
 */

import { StrKey } from '@stellar/stellar-sdk';

export const STROOPS_PER_XLM = 10_000_000n;
export const XLM_DECIMALS = 7;

/**
 * Parse user input into stroops. Rejects rather than rounds: silently dropping
 * an eighth decimal place would move money the user did not agree to.
 */
export function toStroops(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error('Enter a positive amount with up to 7 decimal places.');
  }
  const [whole, frac = ''] = trimmed.split('.');
  return BigInt(whole) * STROOPS_PER_XLM + BigInt(frac.padEnd(XLM_DECIMALS, '0'));
}

/** Exact decimal string, trailing zeros trimmed. `150000000n` -> `"15"`. */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const frac = (abs % STROOPS_PER_XLM)
    .toString()
    .padStart(XLM_DECIMALS, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Display form: thousands separated, at most `maxDecimals` places. */
export function formatXlm(stroops: bigint, maxDecimals = 7): string {
  const [whole, frac = ''] = fromStroops(stroops).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const shown = frac.slice(0, maxDecimals).replace(/0+$/, '');
  return shown ? `${grouped}.${shown}` : grouped;
}

/** Percentage of `total` represented by `part`, clamped to 0–100. */
export function percentOf(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  const pct = Number((part * 10_000n) / total) / 100;
  return Math.min(100, Math.max(0, pct));
}

export function truncateAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** True for well-formed account (G…) or contract (C…) addresses. */
export function isValidAddress(address: string): boolean {
  const value = address.trim();
  try {
    return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
  } catch {
    return false;
  }
}

export function isAccountAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address.trim());
  } catch {
    return false;
  }
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "4m ago", "3d ago" — for the activity tape. */
export function relativeTime(unixSeconds: number, now = Date.now() / 1000): string {
  const delta = Math.max(0, Math.floor(now - unixSeconds));
  if (delta < 45) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}

/**
 * How long is left to deliver. Past the deadline the client may refund, so the
 * copy states that outcome rather than a bare negative duration.
 */
export function deadlineLabel(unixSeconds: number, now = Date.now() / 1000): string {
  const delta = Math.floor(unixSeconds - now);
  if (delta <= 0) return 'Deadline passed';
  if (delta < HOUR) return `${Math.max(1, Math.floor(delta / MINUTE))}m left`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h left`;
  return `${Math.floor(delta / DAY)}d left`;
}

export function isPastDeadline(unixSeconds: number, now = Date.now() / 1000): boolean {
  return unixSeconds <= now;
}

/** `2026-08-09` — used where an exact date matters more than a duration. */
export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Default deadline offered by the create form: two weeks out. */
export function defaultDeadlineDate(now = Date.now()): string {
  return new Date(now + 14 * DAY * 1000).toISOString().slice(0, 10);
}

/** A `yyyy-mm-dd` input value as a unix timestamp at end of that day, UTC. */
export function dateInputToUnix(value: string): number {
  return Math.floor(new Date(`${value}T23:59:59Z`).getTime() / 1000);
}
