/**
 * Event streaming.
 *
 * Escrows are deployed on demand, so their addresses are not knowable up front
 * and cannot be listed in a contract-id filter. That is exactly why every event
 * in the system carries a shared `pact` prefix topic: filtering on the topic
 * subscribes to all three contracts *and* to escrows that do not exist yet.
 *
 * Soroban matches topic filters by exact segment count, so one filter is needed
 * per event arity. StellarPact events carry two to four topics.
 */

import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';

import { getServer, latestLedger } from './stellar';
import type { PactEvent, PactEventKind } from './types';

const PACT_TOPIC = nativeToScVal('pact', { type: 'symbol' }).toXDR('base64');

const FILTERS = [
  { type: 'contract' as const, topics: [[PACT_TOPIC, '*']] },
  { type: 'contract' as const, topics: [[PACT_TOPIC, '*', '*']] },
  { type: 'contract' as const, topics: [[PACT_TOPIC, '*', '*', '*']] },
];

export interface EventPage {
  events: PactEvent[];
  /** Feed back into the next call to resume exactly where this page ended. */
  cursor?: string;
  latestLedger: number;
}

/** Decode one RPC event, or `null` if it is not ours. */
export function normalizeEvent(raw: {
  id: string;
  topic: unknown[];
  value: unknown;
  ledger: number;
  ledgerClosedAt: string;
  contractId?: { toString(): string };
  txHash?: string;
}): PactEvent | null {
  let topics: unknown[];
  try {
    topics = raw.topic.map((t) => scValToNative(t as never));
  } catch {
    return null;
  }

  if (topics[0] !== 'pact' || typeof topics[1] !== 'string') return null;

  let data: Record<string, unknown> = {};
  try {
    data = (scValToNative(raw.value as never) ?? {}) as Record<string, unknown>;
  } catch {
    data = {};
  }

  return {
    id: raw.id,
    kind: topics[1] as PactEventKind,
    contractId: raw.contractId?.toString() ?? '',
    ledger: raw.ledger,
    at: raw.ledgerClosedAt,
    txHash: raw.txHash,
    topics: topics.slice(2),
    data,
  };
}

export async function fetchEvents(options: {
  startLedger?: number;
  cursor?: string;
  limit?: number;
}): Promise<EventPage> {
  const server = getServer();

  // The RPC accepts a start ledger or a cursor, never both.
  const request = options.cursor
    ? { filters: FILTERS, cursor: options.cursor, limit: options.limit ?? 100 }
    : { filters: FILTERS, startLedger: options.startLedger, limit: options.limit ?? 100 };

  const response = await server.getEvents(request as Parameters<typeof server.getEvents>[0]);

  const events = response.events
    .map((raw) => normalizeEvent(raw as never))
    .filter((event): event is PactEvent => event !== null);

  const cursor =
    (response as { cursor?: string }).cursor ??
    (response.events.at(-1) as { pagingToken?: string } | undefined)?.pagingToken ??
    events.at(-1)?.id;

  return { events, cursor, latestLedger: response.latestLedger };
}

/** Where to start when the tape has no history yet. */
export async function startingLedger(lookback: number): Promise<number> {
  const current = await latestLedger();
  return Math.max(1, current - lookback);
}

// ── Presentation ─────────────────────────────────────────────────────────────

/**
 * `held` money has moved into escrow, `paid` money has reached the worker, and
 * `risk` covers the paths where a deal did not go as agreed. The tape colours
 * itself from this, so the tone is derived from what happened to the funds
 * rather than assigned per event by hand.
 */
export type EventTone = 'held' | 'paid' | 'risk' | 'neutral';

export interface EventSummary {
  /** Past-tense, matching the button that caused it. */
  label: string;
  tone: EventTone;
  /** The address the event is about, when there is one. */
  subject?: string;
  /** Stroops moved, when any moved. */
  amount?: bigint;
  note?: string;
}

const asBigInt = (value: unknown): bigint | undefined =>
  typeof value === 'bigint' ? value : typeof value === 'number' ? BigInt(value) : undefined;

const asAddress = (value: unknown): string | undefined =>
  typeof value === 'string' && (value.startsWith('G') || value.startsWith('C'))
    ? value
    : undefined;

export function describeEvent(event: PactEvent): EventSummary {
  const [first, second] = event.topics;
  const { data } = event;

  switch (event.kind) {
    case 'created':
      return {
        label: 'Deal created',
        tone: 'neutral',
        subject: asAddress(first),
        amount: asBigInt(data.total_amount),
        note: typeof data.title === 'string' ? data.title : undefined,
      };
    case 'funded':
      return {
        label: 'Escrow funded',
        tone: 'held',
        subject: asAddress(first),
        amount: asBigInt(data.amount),
      };
    case 'submitted':
      return {
        label: `Milestone ${Number(second ?? 0) + 1} submitted`,
        tone: 'neutral',
        subject: asAddress(first),
        note: typeof data.note === 'string' ? data.note : undefined,
      };
    case 'approved':
      return {
        label: `Milestone ${Number(second ?? 0) + 1} approved`,
        tone: 'paid',
        subject: asAddress(first),
        amount: asBigInt(data.amount),
      };
    case 'released':
      return {
        label: 'Deal completed',
        tone: 'paid',
        subject: asAddress(first),
        amount: asBigInt(data.total_amount),
      };
    case 'refunded':
      return {
        label: 'Client refunded',
        tone: 'risk',
        subject: asAddress(first),
        amount: asBigInt(data.refunded),
      };
    case 'disputed':
      return {
        label: 'Dispute raised',
        tone: 'risk',
        subject: asAddress(first),
        amount: asBigInt(data.total_amount),
      };
    case 'resolved':
      return {
        label: data.paid_worker ? 'Dispute settled for worker' : 'Dispute settled for client',
        tone: data.paid_worker ? 'paid' : 'risk',
        subject: asAddress(first),
        amount: asBigInt(data.amount),
      };
    case 'recorded':
      return {
        label: data.success ? 'Reputation credited' : 'Reputation marked failed',
        tone: data.success ? 'paid' : 'risk',
        subject: asAddress(first),
        amount: asBigInt(data.total_earned),
      };
    case 'paused':
      return { label: data.paused ? 'New deals paused' : 'New deals resumed', tone: 'neutral' };
    case 'wired':
      return { label: 'Reputation wired to registry', tone: 'neutral' };
    case 'wasm':
      return { label: 'Escrow implementation updated', tone: 'neutral' };
    case 'admin':
      return { label: 'Admin rotated', tone: 'neutral', subject: asAddress(first) };
    default:
      return { label: event.kind, tone: 'neutral' };
  }
}
